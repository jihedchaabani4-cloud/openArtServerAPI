/**
 * GenerationService
 * Domain Service — owns all generation read/mutation business logic.
 *
 * Extracted from: generationsQueryController.js, generationsMutationController.js
 * Feature: 026-backend-platform-layer-refactor
 *
 * Layer: Domain (src/domain/generation/)
 * Dependencies: db.projects, db.workflows, db.media, db.configs (via Repositories only)
 * No direct supabase imports — all DB access via injected `db` repositories.
 */

import { randomUUID } from "node:crypto";
import { isModelHidden } from "../../../lib/modelRegistryKeys.js";

// ── Structured log helper (FR-011) ───────────────────────────────────────────

function log(operation, status, meta = {}) {
    console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        operation: `GenerationService.${operation}`,
        status,
        ...meta,
    }));
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
                        status: media.status,
                        error_message: media.error_message,
                        create_time: media.create_time,
                    }
                    : null,
                generation_info: generationInfo,
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
        const devBypass = process.env.DEV_AUTH_BYPASS === "true";
        if (!isOwner && !devBypass) {
            const err = new Error("Unauthorized access to this project");
            err.statusCode = 403;
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
}
