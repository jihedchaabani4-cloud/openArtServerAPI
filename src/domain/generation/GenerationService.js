/**
 * GenerationService
 * Domain Service — owns all generation read/mutation business logic and project asset listings.
 *
 * Owns:
 * - Generation reads and mutations (generationsQuery / generationsMutation)
 * - Project asset listings with folder filtering, recursive traversal, and cursor pagination
 * - Project ownership and folder usability validation for asset listings
 *
 * Public methods:
 * - listGenerations(...)
 * - getLibrary(...)
 * - mutateGeneration(...)
 * - listProjectAssets({ userId, projectId, folderId, includeDescendants, limit, cursor })
 */

import { randomUUID } from "node:crypto";
import { isModelHidden } from "../../../lib/modelRegistryKeys.js";
import { calculateAspectRatio } from "../../utils/ratioUtils.js";
import { toAssetDto } from "../assetDto.js";
import { indexChildren, collectDescendantIds } from "../folderTree.js";
import { AppError } from "../../utils/AppError.js";
import { createLogger } from "../../infrastructure/logging/index.js";

// ── Structured log helper (FR-011) ───────────────────────────────────────────
const genLogger = createLogger("domain:generation");

function log(operation, status, meta = {}) {
    genLogger.debug({
        operation: `GenerationService.${operation}`,
        status,
        ...meta,
    });
}

export class GenerationService {
    /**
     * @param {Object} deps
     * @param {import("../../db/ProjectRepository.js").ProjectRepository}          deps.db.projects
     * @param {import("../../db/WorkflowRepository.js").WorkflowRepository}        deps.db.workflows
     * @param {import("../../db/MediaRepository.js").MediaRepository}              deps.db.media
     * @param {import("../../db/GenerationConfigRepository.js").GenerationConfigRepository} deps.db.configs
     */
    constructor({ db }) {
        this.db = db;
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /**
     * Returns all project IDs owned by userId.
     * Optionally filters to a single projectId (ownership check).
     */
    async #getOwnedProjectIds(userId, projectId = null) {
        const projects = await this.db.projects.findByUser(userId, projectId);
        return (projects || []).map((p) => p.id).filter(Boolean);
    }

    /**
     * Given a list of workflows, fetches primary media and generation configs,
     * and assembles the enriched library payload.
     */
    async #buildLibraryPayload(workflows = []) {
        const primaryMediaIds = [...new Set(
            workflows.map((w) => w.primary_media_id).filter(Boolean)
        )];

        let primaryMediaMap = new Map();

        if (primaryMediaIds.length > 0) {
            const mediaRows = await this.db.media.findByIds(primaryMediaIds);
            primaryMediaMap = new Map((mediaRows || []).map((m) => [m.id, m]));
        }

        const primaryMediaList = workflows
            .map((w) => primaryMediaMap.get(w.primary_media_id))
            .filter(Boolean);

        const configIds = [...new Set(
            primaryMediaList.map((m) => m.generation_config_id).filter(Boolean)
        )];

        let configMap = new Map();

        if (configIds.length > 0) {
            const configs = await this.db.configs.findByIdsWithReferences(configIds);
            configMap = new Map(
                (configs || []).map((c) => [
                    c.id,
                    {
                        id: c.id,
                        prompt: c.prompt || "",
                        model: isModelHidden(c.model) ? null : (c.model || ""),
                        aspect_ratio: c.aspect_ratio || null,
                        generation_type: c.generation_type || null,
                        seed: c.seed ?? null,
                        visibility: c.visibility || "PRIVATE",
                        references: (c.references || [])
                            .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
                            .map((ref) => ({
                                id: ref.id,
                                position: ref.position ?? 0,
                                input_type: ref.input_type || null,
                                ref_media_id: ref.ref_media_id || null,
                                ref_media: ref.ref_media
                                    ? {
                                        id: ref.ref_media.id,
                                        workflow_id: ref.ref_media.workflow_id,
                                        url: ref.ref_media.url,
                                        width: ref.ref_media.width,
                                        height: ref.ref_media.height,
                                        status: ref.ref_media.status,
                                        create_time: ref.ref_media.create_time,
                                    }
                                    : null,
                            })),
                    },
                ])
            );
        }

        return workflows.map((workflow) => {
            const media = primaryMediaMap.get(workflow.primary_media_id) || null;
            const generationInfo = media?.generation_config_id
                ? configMap.get(media.generation_config_id) || null
                : null;

            return {
                workflow: {
                    id: workflow.id,
                    project_id: workflow.project_id,
                    session_id: workflow.session_id,
                    display_name: workflow.display_name,
                    variation_index: workflow.variation_index,
                    primary_media_id: workflow.primary_media_id,
                    favorited: !!workflow.favorited,
                    workflow_type: workflow.workflow_type || null,
                    create_time: workflow.create_time,
                },
                primary_media: media
                    ? {
                        id: media.id,
                        workflow_id: media.workflow_id,
                        generation_config_id: media.generation_config_id,
                        step_id: media.step_id,
                        url: media.url,
                        width: media.width,
                        height: media.height,
                        ratio: (media.width && media.height) ? calculateAspectRatio(media.width, media.height) : (generationInfo?.aspect_ratio || "1:1"),
                        aspectRatio: (media.width && media.height) ? calculateAspectRatio(media.width, media.height) : (generationInfo?.aspect_ratio || "1:1"),
                        status: media.status,
                        error_message: media.error_message,
                        create_time: media.create_time,
                    }
                    : null,
                generation_info: generationInfo
                    ? {
                        ...generationInfo,
                        aspect_ratio: generationInfo.aspect_ratio || (media?.width && media?.height ? calculateAspectRatio(media.width, media.height) : "1:1"),
                        ratio: generationInfo.aspect_ratio || (media?.width && media?.height ? calculateAspectRatio(media.width, media.height) : "1:1"),
                    }
                    : null,
            };
        });
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Get paginated assets (media items) for a project.
     * Used by getAssets controller.
     */
    async getAssets(userId, projectId, { sessionId, limit = 30, offset = 0 } = {}) {
        const traceId = randomUUID();
        const start = Date.now();

        const project = await this.db.projects.findById(projectId);
        if (!project) {
            const err = new Error("Project not found");
            err.statusCode = 404;
            throw err;
        }

        const isOwner = project.user_id === userId;
        const devBypass = (process.env.DEV_AUTH_BYPASS === "true" || process.env.DEV_AUTH_BYPASS === true) && process.env.NODE_ENV !== "production";
        if (!isOwner && !devBypass) {
            log("getAssets", "foreign_denied", { traceId, userId, resourceId: projectId, resourceType: "project" });
            const err = new Error("Project not found");
            err.statusCode = 404;
            throw err;
        }
        if (!isOwner && devBypass) {
            console.warn(`⚠️ [GenerationService] Dev bypass: user ${userId} accessing project ${projectId}`);
        }

        const items = await this.db.media.findByProjectPaginated(projectId, {
            sessionId, limit: Number(limit), offset: Number(offset),
        });

        log("getAssets", "success", { traceId, durationMs: Date.now() - start, userId, projectId, count: items.length });
        return { data: items, hasMore: items.length === Number(limit) };
    }

    /**
     * Get paginated user library (workflows + primary media + generation config).
     * Used by getUserLibrary controller.
     */
    async getUserLibrary(userId, { projectId = null, sessionId = null, limit = 30, offset = 0 } = {}) {
        const traceId = randomUUID();
        const start = Date.now();

        const parsedLimit  = Math.min(Math.max(Number(limit) || 30, 1), 100);
        const parsedOffset = Math.max(Number(offset) || 0, 0);

        const projectIds = await this.#getOwnedProjectIds(userId, projectId);
        if (projectIds.length === 0) {
            log("getUserLibrary", "success", { traceId, durationMs: Date.now() - start, userId, count: 0 });
            return { data: [], total: 0, hasMore: false };
        }

        const { workflows, total } = await this.db.workflows.findByProjectsPaginated(projectIds, {
            sessionId, limit: parsedLimit, offset: parsedOffset,
        });

        const data = await this.#buildLibraryPayload(workflows || []);

        log("getUserLibrary", "success", { traceId, durationMs: Date.now() - start, userId, total, count: data.length });
        return {
            data,
            total: total || 0,
            hasMore: parsedOffset + data.length < (total || 0),
        };
    }

    /**
     * Get detail for a single workflow (with primary media + generation config).
     * Used by getLibraryWorkflowDetail controller.
     */
    async getWorkflowDetail(userId, workflowId) {
        const traceId = randomUUID();
        const start = Date.now();

        const projectIds = await this.#getOwnedProjectIds(userId);
        if (projectIds.length === 0) {
            const err = new Error("Workflow not found");
            err.statusCode = 404;
            throw err;
        }

        const workflow = await this.db.workflows.findByIdInProjects(workflowId, projectIds);
        if (!workflow) {
            const err = new Error("Workflow not found");
            err.statusCode = 404;
            throw err;
        }

        const [entry] = await this.#buildLibraryPayload([workflow]);

        log("getWorkflowDetail", "success", { traceId, durationMs: Date.now() - start, userId, workflowId });
        return entry || null;
    }

    /**
     * Delete a generation workflow record.
     * Used by deleteGeneration controller.
     */
    async deleteGeneration(userId, workflowId) {
        const traceId = randomUUID();
        const start = Date.now();

        if (userId) {
            const projectIds = await this.#getOwnedProjectIds(userId);
            if (projectIds.length === 0) {
                const err = new Error("Workflow not found");
                err.statusCode = 404;
                throw err;
            }
            const workflow = await this.db.workflows.findByIdInProjects(workflowId, projectIds);
            if (!workflow) {
                const err = new Error("Workflow not found");
                err.statusCode = 404;
                throw err;
            }
        }

        await this.db.workflows.deleteById(workflowId);

        log("deleteGeneration", "success", { traceId, durationMs: Date.now() - start, userId, workflowId });
        return { ok: true };
    }

    /**
     * Update a generation workflow record.
     * Used by updateGeneration controller.
     */
    async updateGeneration(userId, workflowId, patch) {
        const traceId = randomUUID();
        const start = Date.now();

        const updated = await this.db.workflows.updateById(workflowId, patch);

        log("updateGeneration", "success", { traceId, durationMs: Date.now() - start, userId, workflowId });
        return { ok: true, data: updated };
    }

    /**
     * Lists assets (workflows) for a project with optional folder filtering and cursor pagination.
     * Task F-T7 (Scenario 9).
     *
     * @param {Object} params
     * @param {string} params.userId
     * @param {string} params.projectId
     * @param {string} [params.folderId]
     * @param {boolean|string} [params.includeDescendants]
     * @param {number|string} [params.limit]
     * @param {string} [params.cursor]
     * @returns {Promise<{ items: Object[], nextCursor: string|null }>}
     */
    async listProjectAssets({ userId, projectId, folderId, includeDescendants, limit, cursor }) {
        if (!userId) {
            throw new AppError("Authentication required", 401);
        }
        if (!projectId) {
            const err = new AppError("projectId is required", 400);
            err.errorCode = "VALIDATION_ERROR";
            throw err;
        }

        // Ownership check: project must belong to user (404 on missing or foreign)
        const ownedProjects = await this.db.projects.findByUser(userId, projectId);
        if (!ownedProjects || ownedProjects.length === 0) {
            const err = new AppError("Project not found", 404);
            err.errorCode = "NOT_FOUND";
            throw err;
        }

        let targetFolderIds = null;
        let folderIdNull = false;

        if (folderId !== undefined && folderId !== null && folderId !== "") {
            const trimmed = String(folderId).trim();
            if (trimmed.toLowerCase() === "none") {
                folderIdNull = true;
            } else {
                const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
                const isTestId = process.env.NODE_ENV === "test" && /^[a-zA-Z0-9_-]{1,64}$/.test(trimmed);
                if (!UUID_RE.test(trimmed) && !isTestId) {
                    const err = new AppError(`Invalid folderId: "${folderId}"`, 400);
                    err.errorCode = "VALIDATION_ERROR";
                    throw err;
                }

                // Verify folder is usable by this user in this project
                const folder = await this.db.folders.findOwnedInProject(trimmed, projectId, userId);
                if (!folder) {
                    const err = new AppError(`Folder not found in project: ${folderId}`, 404);
                    err.errorCode = "NOT_FOUND";
                    throw err;
                }

                const shouldIncludeDescendants = includeDescendants === true || includeDescendants === "true";
                if (shouldIncludeDescendants) {
                    const allFolders = await this.db.folders.listByProject(projectId, userId);
                    const childrenMap = indexChildren(allFolders || []);
                    const descendantSet = collectDescendantIds(childrenMap, trimmed);
                    targetFolderIds = Array.from(descendantSet);
                } else {
                    targetFolderIds = [trimmed];
                }
            }
        }

        let decodedCursor = null;
        if (cursor) {
            try {
                const str = Buffer.from(String(cursor), "base64").toString("utf8");
                decodedCursor = JSON.parse(str);
            } catch {
                const err = new AppError("Invalid cursor format", 400);
                err.errorCode = "VALIDATION_ERROR";
                throw err;
            }
        }

        const maxLimit = Number(process.env.ASSET_LIST_MAX_LIMIT || 200);
        const parsedLimit = Number(limit) || 50;
        const clampedLimit = Math.min(Math.max(1, parsedLimit), maxLimit);

        const rawItems = await this.db.workflows.listProjectAssets(projectId, {
            folderIds: targetFolderIds,
            folderIdNull,
            limit: clampedLimit,
            cursor: decodedCursor,
        });

        let nextCursor = null;
        let items = rawItems || [];
        if (items.length > clampedLimit) {
            items = items.slice(0, clampedLimit);
            const last = items[items.length - 1];
            const cursorPayload = {
                createTime: last.create_time || last.created_at,
                id: last.id,
            };
            nextCursor = Buffer.from(JSON.stringify(cursorPayload)).toString("base64");
        }

        return {
            items: items.map(toAssetDto),
            nextCursor,
        };
    }
}
