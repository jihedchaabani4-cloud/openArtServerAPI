/**
 * MediaService
 * Canonical owner of the Media application entity.
 *
 * Clean Architecture Boundary:
 *   - Represents the canonical Media entity in the database (`media` table).
 *   - Encapsulates media record creation, lookup, status updates, and field mutations.
 *   - Works in tandem with WorkflowMediaService (relationships) and StorageService (physical files).
 *
 * Feature: 026-backend-platform-layer-refactor / Canonical Media Architecture
 */

import { randomUUID } from "node:crypto";
import { crudOperationLog, CrudServiceError } from "../../utils/crudOperationLog.js";
import { createMediaInWorkflow } from "../../db/workflowMediaLinker.js";

export class MediaService {
    /**
     * @param {Object} deps
     * @param {Object} deps.db                   - Repository map (db.media, db.workflows)
     */
    constructor({ db }) {
        this.db = db;
    }

    /**
     * Create a canonical media record in the database.
     *
     * @param {Object} params
     * @param {string} params.workflowId
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
        workflowId,
        projectId = null,
        generationConfigId = null,
        stepId = "upload",
        url,
        width = 1024,
        height = 1024,
        status = "success",
        errorMessage = null,
        ...extra
    }) {
        const traceId = randomUUID();
        const start = Date.now();

        crudOperationLog({ traceId, operation: "createMedia:start", workflowId, stepId });

        try {
            if (!workflowId) {
                throw new CrudServiceError("workflowId is required to create a media record.", {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                    traceId,
                    operation: "createMedia",
                });
            }

            const { workflow_id: _ignoredWfId, role, workflowType, workflow_type, ...restExtra } = extra;
            const mediaRecord = await this.db.media.createMedia({
                project_id: projectId,
                generation_config_id: generationConfigId,
                step_id: stepId,
                url,
                width: Number(width) || 1024,
                height: Number(height) || 1024,
                status,
                error_message: errorMessage,
                ...restExtra,
            });

            await createMediaInWorkflow(this.db, {
                workflowId,
                mediaId: mediaRecord?.id,
                stepId,
                ...(role ? { role } : {}),
                ...(workflowType || workflow_type ? { workflowType: workflowType || workflow_type } : {}),
                operation: "createMedia:linkWorkflowMedia",
            });

            crudOperationLog({
                traceId,
                operation: "createMedia:success",
                status: "ok",
                durationMs: Date.now() - start,
                mediaId: mediaRecord.id,
                workflowId,
            });

            return mediaRecord;
        } catch (err) {
            crudOperationLog({
                traceId,
                operation: "createMedia:error",
                status: "error",
                durationMs: Date.now() - start,
                errorCode: err.statusCode || 500,
                message: err.message,
            });
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
        try {
            return await this.db.media.findById(mediaId, columns);
        } catch (err) {
            crudOperationLog({
                operation: "findById",
                status: "warning",
                mediaId,
                message: err.message,
            });
            return null;
        }
    }

    /**
     * Retrieve multiple media records by an array of UUIDs.
     *
     * @param {string[]} mediaIds
     * @returns {Promise<Object[]>}
     */
    async findByIds(mediaIds) {
        if (!Array.isArray(mediaIds) || mediaIds.length === 0) return [];
        try {
            return await this.db.media.findByIds(mediaIds);
        } catch (err) {
            crudOperationLog({
                operation: "findByIds",
                status: "warning",
                count: mediaIds.length,
                message: err.message,
            });
            return [];
        }
    }

    /**
     * Retrieve all media records attached to a specific workflow container.
     *
     * @param {string} workflowId
     * @returns {Promise<Object[]>}
     */
    async findByWorkflow(workflowId) {
        if (!workflowId) return [];
        try {
            return await this.db.media.findByWorkflow(workflowId);
        } catch (err) {
            crudOperationLog({
                operation: "findByWorkflow",
                status: "warning",
                workflowId,
                message: err.message,
            });
            return [];
        }
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
        return this.db.media.updateFields(mediaId, {
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
        return this.db.media.updateFields(mediaId, fields);
    }

    /**
     * Delete a media record row from database.
     *
     * @param {string} mediaId
     * @returns {Promise<boolean>}
     */
    async deleteById(mediaId) {
        return this.db.media.deleteById(mediaId);
    }
}

export default MediaService;
