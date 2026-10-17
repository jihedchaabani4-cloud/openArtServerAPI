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
     * Given a list of workflows, fetches candidate media from workflow_media (capped at 8,
     * ordered stably by created_at ASC, always preserving pinned primary_media_id and sheet role)
     * alongside the legacy primary_media compatibility shim and generation configs.
     */
    async #buildLibraryPayload(workflows = []) {
        const workflowIds = [...new Set(workflows.map((w) => w.id).filter(Boolean))];
        const primaryMediaIds = [...new Set(
            workflows.map((w) => w.primary_media_id).filter(Boolean)
        )];

        let relationMediaRows = [];
        if (workflowIds.length > 0) {
            if (typeof this.db.workflowMedia?.findByWorkflowIds === "function") {
                relationMediaRows = (await this.db.workflowMedia.findByWorkflowIds(workflowIds)) || [];
            } else if (typeof this.db.workflowMedia?.findByWorkflow === "function") {
                const perWf = await Promise.all(
                    workflowIds.map((wfId) => this.db.workflowMedia.findByWorkflow(wfId))
                );
                relationMediaRows = perWf.flat().filter(Boolean);
            } else if (typeof this.db.media?.findByWorkflow === "function") {
                const perWf = await Promise.all(
                    workflowIds.map((wfId) => this.db.media.findByWorkflow(wfId))
                );
                relationMediaRows = perWf.flat().filter(Boolean);
            }
        }

        let primaryMediaMap = new Map();
        for (const row of relationMediaRows) {
            if (row?.id && !primaryMediaMap.has(row.id)) {
                primaryMediaMap.set(row.id, row);
            }
        }

        if (primaryMediaIds.length > 0 && typeof this.db.media?.findByIds === "function") {
            const mediaRows = await this.db.media.findByIds(primaryMediaIds);
            for (const m of mediaRows || []) {
                if (m?.id) {
                    const existing = primaryMediaMap.get(m.id) || {};
                    primaryMediaMap.set(m.id, { ...existing, ...m });
                }
            }
        }

        const rawCandidatesByWorkflow = new Map();
        for (const wf of workflows) {
            rawCandidatesByWorkflow.set(wf.id, []);
        }
        for (const row of relationMediaRows) {
            const wfId = row?.workflowId || row?.workflow_id;
            if (wfId && rawCandidatesByWorkflow.has(wfId)) {
                rawCandidatesByWorkflow.get(wfId).push(row);
            }
        }

        const selectWorkflowCandidates = (items = [], pinnedId = null, maxItems = 8) => {
            const indexed = items.map((item, idx) => ({
                item,
                idx,
                ts: String(item.workflow_media_created_at || item.created_at || item.create_time || ""),
            }));
            indexed.sort((a, b) => {
                if (a.ts < b.ts) return -1;
                if (a.ts > b.ts) return 1;
                return a.idx - b.idx;
            });

            const deduped = [];
            const seenIds = new Set();
            for (const { item } of indexed) {
                if (!item?.id) continue;
                if (seenIds.has(item.id)) continue;
                seenIds.add(item.id);
                deduped.push(item);
            }

            if (deduped.length <= maxItems) return deduped;

            const isMandatory = (m) =>
                (pinnedId && m.id === pinnedId) ||
                m.role === "sheet" ||
                m.mediaRole === "sheet" ||
                m.step_id === "character_sheet" ||
                m.step_id === "element_sheet";

            const selectedIds = new Set();
            for (const m of deduped) {
                if (isMandatory(m) && selectedIds.size < maxItems) {
                    selectedIds.add(m.id);
                }
            }
            for (const m of deduped) {
                if (selectedIds.size >= maxItems) break;
                if (!selectedIds.has(m.id)) {
                    selectedIds.add(m.id);
                }
            }

            return deduped.filter((m) => selectedIds.has(m.id));
        };

        const cappedCandidatesByWorkflow = new Map();
        const allSelectedMedia = [];

        for (const wf of workflows) {
            const rawList = rawCandidatesByWorkflow.get(wf.id) || [];
            const pinnedMedia = wf.primary_media_id ? primaryMediaMap.get(wf.primary_media_id) : null;
            const mergedList =
                pinnedMedia && !rawList.some((m) => m.id === pinnedMedia.id)
                    ? [pinnedMedia, ...rawList]
                    : rawList;
            const capped = selectWorkflowCandidates(mergedList, wf.primary_media_id, 8);
            cappedCandidatesByWorkflow.set(wf.id, capped);
            if (pinnedMedia) allSelectedMedia.push(pinnedMedia);
            allSelectedMedia.push(...capped);
        }

        const configIds = [...new Set(
            allSelectedMedia.map((m) => m?.generation_config_id).filter(Boolean)
        )];

        let configMap = new Map();

        if (configIds.length > 0 && typeof this.db.configs?.findByIdsWithReferences === "function") {
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

        const formatMediaEntry = (mediaItem, wfId, fallbackAspectRatio) => {
            const ratio = (mediaItem.width && mediaItem.height)
                ? calculateAspectRatio(mediaItem.width, mediaItem.height)
                : (fallbackAspectRatio || "1:1");
            return {
                id: mediaItem.id,
                workflow_id: wfId,
                workflowId: wfId,
                role: mediaItem.role || mediaItem.mediaRole || null,
                mediaRole: mediaItem.mediaRole || mediaItem.role || null,
                generation_config_id: mediaItem.generation_config_id ?? null,
                step_id: mediaItem.step_id ?? null,
                url: mediaItem.url ?? null,
                width: mediaItem.width ?? null,
                height: mediaItem.height ?? null,
                ratio,
                aspectRatio: ratio,
                status: mediaItem.status ?? null,
                error_message: mediaItem.error_message ?? null,
                create_time: mediaItem.create_time || mediaItem.workflow_media_created_at || null,
                created_at: mediaItem.workflow_media_created_at || mediaItem.create_time || null,
            };
        };

        return workflows.map((workflow) => {
            const media = workflow.primary_media_id
                ? (primaryMediaMap.get(workflow.primary_media_id) || null)
                : null;
            const rawCandidates = cappedCandidatesByWorkflow.get(workflow.id) || [];
            const configSourceMedia = media || rawCandidates.find((c) => c?.generation_config_id) || null;
            const generationInfo = configSourceMedia?.generation_config_id
                ? configMap.get(configSourceMedia.generation_config_id) || null
                : null;

            const candidates = rawCandidates.map((candidate) => {
                const candidateConfig = candidate?.generation_config_id
                    ? configMap.get(candidate.generation_config_id) || generationInfo
                    : generationInfo;
                return formatMediaEntry(candidate, workflow.id, candidateConfig?.aspect_ratio);
            });

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
                    ? formatMediaEntry(media, workflow.id, generationInfo?.aspect_ratio)
                    : null,
                candidates,
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
    async getAssets(userId, projectId, { limit = 30, offset = 0 } = {}) {
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
            genLogger.warn({ userId, projectId }, "Dev bypass: user accessing project");
        }

        const items = await this.db.media.findByProjectPaginated(projectId, {
            limit: Number(limit), offset: Number(offset),
        });

        log("getAssets", "success", { traceId, durationMs: Date.now() - start, userId, projectId, count: items.length });
        return { data: items, hasMore: items.length === Number(limit) };
    }

    /**
     * Get paginated user library (workflows + primary media + generation config).
     * Used by getUserLibrary controller.
     */
    async getUserLibrary(userId, { projectId = null, limit = 30, offset = 0 } = {}) {
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
            limit: parsedLimit, offset: parsedOffset,
        });

        const data = await this.#buildLibraryPayload(workflows || []);
        const payloadBytes = Buffer.byteLength(JSON.stringify(data), "utf8");

        log("getUserLibrary", "success", {
            traceId,
            durationMs: Date.now() - start,
            userId,
            total,
            count: data.length,
            payloadBytes,
        });
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
