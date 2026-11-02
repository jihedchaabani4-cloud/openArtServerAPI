/**
 * MediaService
 * Canonical owner of the Media application entity (`public.media`).
 *
 * @owns Canonical CRUD, status transitions, and metadata queries for public.media records.
 *
 * Clean Architecture Boundary:
 *   - Represents the canonical Media entity in the database (`public.media` table).
 *   - Encapsulates media record creation, lookup, status updates, and field mutations.
 *   - Strictly independent of `public.workflow_media` (owned by WorkflowMediaService) and physical object storage (StorageService).
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "../../infrastructure/logging/index.js";

const mediaLogger = createLogger("media_service");

export class MediaService {
    /**
     * @param {Object} deps
     * @param {Object} [deps.mediaRepo] - MediaRepository instance
     * @param {Object} [deps.db]        - Repository map containing db.media
     */
    constructor({ mediaRepo = null, db = null } = {}) {
        const resolvedRepo = mediaRepo || db?.media;
        if (!resolvedRepo || typeof resolvedRepo.createMedia !== "function") {
            throw new Error("MediaService requires mediaRepo (or db.media) implementing createMedia.");
        }
        this.mediaRepo = resolvedRepo;
    }

    /**
     * Create a canonical media record in `public.media`.
     * Does NOT write to `public.workflow_media` (workflow linking belongs to WorkflowMediaService).
     *
     * @param {Object} params
     * @param {string} [params.projectId]
     * @param {string} [params.generationConfigId]
     * @param {string} [params.stepId="upload"]
     * @param {string} params.url
     * @param {number} [params.width=1024]
     * @param {number} [params.height=1024]
     * @param {string} [params.status="success"]
     * @param {string} [params.errorMessage=null]
     * @returns {Promise<Object>} Created media record
     */
    async createMedia({
        projectId = null,
        stepId = "upload",
        url,
        width = 1024,
        height = 1024,
        status = "success",
        errorMessage = null,
        generationConfigId = undefined,
        ...extra
    } = {}) {
        const traceId = randomUUID();
        const start = Date.now();

        const {
            workflowId: _ignoredWorkflowIdProp,
            workflow_id: _ignoredWfId,
            role: _ignoredRole,
            workflowType: _ignoredWfTypeProp,
            workflow_type: _ignoredWfType,
            is_primary: _ignoredIsPrimaryCol,
            isPrimary: _ignoredIsPrimaryProp,
            generation_config_id: extraGenConfigId,
            ...restExtra
        } = extra;

        const resolvedGenerationConfigId = generationConfigId ?? extraGenConfigId;

        try {
            const mediaRecord = await this.mediaRepo.createMedia({
                project_id: projectId,
                step_id: stepId,
                url,
                width: Number(width) || 1024,
                height: Number(height) || 1024,
                status,
                error_message: errorMessage,
                ...(resolvedGenerationConfigId !== undefined ? { generation_config_id: resolvedGenerationConfigId } : {}),
                ...restExtra,
            });

            mediaLogger.info(
                {
                    event: "media.created",
                    traceId,
                    mediaId: mediaRecord?.id,
                    projectId,
                    stepId,
                    durationMs: Date.now() - start,
                },
                "Created media record"
            );

            return mediaRecord;
        } catch (err) {
            mediaLogger.error(
                {
                    event: "media.create_failed",
                    traceId,
                    projectId,
                    stepId,
                    durationMs: Date.now() - start,
                    err: err?.message,
                },
                "Failed to create media record"
            );
            throw err;
        }
    }

    /**
     * Retrieve a canonical media record by its UUID.
     *
     * @param {string} mediaId
     * @param {string} [columns="*"]
     * @returns {Promise<Object|null>}
     */
    async findById(mediaId, columns = "*") {
        if (!mediaId) return null;
        return this.mediaRepo.findById(mediaId, columns);
    }

    /**
     * Retrieve multiple media records by an array of UUIDs.
     *
     * @param {string[]} mediaIds
     * @returns {Promise<Object[]>}
     */
    async findByIds(mediaIds) {
        if (!Array.isArray(mediaIds) || mediaIds.length === 0) return [];
        return this.mediaRepo.findByIds(mediaIds);
    }

    /**
     * Retrieve a canonical media record by its public URL.
     *
     * @param {string} url
     * @returns {Promise<Object|null>}
     */
    async findByUrl(url) {
        if (!url) return null;
        return this.mediaRepo.findByUrl(url);
    }

    /**
     * Retrieve paginated media records belonging to a project.
     *
     * @param {string} projectId
     * @param {Object} [options]
     * @param {number} [options.limit=30]
     * @param {number} [options.offset=0]
     * @returns {Promise<Object[]>}
     */
    async findByProject(projectId, { limit = 30, offset = 0 } = {}) {
        if (!projectId) return [];
        return this.mediaRepo.findByProject(projectId, limit, offset);
    }

    /**
     * Retrieve the media record joined with its project owner (`id, project(user_id)`).
     *
     * @param {string} mediaId
     * @returns {Promise<{ id: string, project: { user_id: string|null }|null }|null>}
     */
    async findOwnershipRecord(mediaId) {
        if (!mediaId) return null;
        return this.mediaRepo.findMediaOwnershipRecord(mediaId);
    }

    /**
     * List lightweight media rows (`id, url, project_id`) for diagnostics and orphan scans.
     *
     * @param {Object} [options]
     * @param {string|null} [options.projectId=null]
     * @param {number} [options.limit=500]
     * @returns {Promise<Object[]>}
     */
    async listAll({ projectId = null, limit = 500 } = {}) {
        return this.mediaRepo.listAll({ projectId, limit });
    }

    /**
     * Update the processing status of a media record.
     *
     * @param {string} mediaId
     * @param {"pending"|"processing"|"success"|"failed"} status
     * @param {string} [errorMessage=null]
     * @returns {Promise<Object>}
     */
    async updateStatus(mediaId, status, errorMessage = null) {
        return this.mediaRepo.updateFields(mediaId, {
            status,
            error_message: errorMessage,
        });
    }

    /**
     * Update fields of a canonical media record.
     *
     * @param {string} mediaId
     * @param {Object} fields
     * @returns {Promise<Object>}
     */
    async updateFields(mediaId, fields = {}) {
        return this.mediaRepo.updateFields(mediaId, fields);
    }

    /**
     * Delete a media record row from `public.media`.
     *
     * @param {string} mediaId
     * @returns {Promise<boolean|void>}
     */
    async deleteById(mediaId) {
        return this.mediaRepo.deleteById(mediaId);
    }
}

export default MediaService;
