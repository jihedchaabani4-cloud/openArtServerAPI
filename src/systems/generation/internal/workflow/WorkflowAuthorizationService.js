import { createLogger, envConfig } from "#shared";

const authLogger = createLogger("workflow_auth");

/**
 * WorkflowAuthorizationService
 * @owns System 1: Generation & Workflows
 * Dedicated security and ownership verification service for workflows and media assets.
 * Encapsulates internal service-to-service secrets, development bypasses, and project owner checks.
 */
export class WorkflowAuthorizationService {
    /**
     * @param {Object} deps
     * @param {Object} deps.db - Repository map (db.workflows, db.projects, db.media)
     */
    constructor({ db }) {
        this.db = db;
    }

    _isBypassed(_req = null) {
        return envConfig.devAuthBypass;
    }

    /**
     * Verifies that a given user owns the project associated with a single workflow.
     */
    async verifyWorkflowOwnership(workflowId, userId, req = null) {
        if (!workflowId) return false;
        if (this._isBypassed(req)) return true;

        const result = await this.verifyWorkflowOwnershipBulk([workflowId], userId, req);
        return Boolean(result && result.length === 1);
    }

    /**
     * Bulk checks ownership for an array of workflow IDs.
     * Returns array of owned workflow IDs if all match, or null if any unauthorized.
     */
    async verifyWorkflowOwnershipBulk(workflowIds = [], userId, req = null) {
        const cleanIds = [...new Set((workflowIds || []).map((id) => String(id || "").replace(/^workflows\//, "").trim()).filter(Boolean))];
        if (!cleanIds.length) return [];
        if (this._isBypassed(req)) return cleanIds;

        // Query workflows joined with their project owner
        const { data, error } = await this.db.workflows.client()
            .from("workflow")
            .select("id, project:project!project_id(user_id)")
            .in("id", cleanIds);

        if (error) {
            authLogger.error({ event: "workflow_auth.bulk_error", err: error.message }, "verifyWorkflowOwnershipBulk error");
            throw error;
        }

        const ownedIds = (data || [])
            .filter((wf) => wf.project?.user_id === userId)
            .map((wf) => wf.id);

        if (ownedIds.length !== cleanIds.length) {
            authLogger.warn({ event: "workflow_auth.access_denied", userId, requestedIds: cleanIds, ownedIds }, "Foreign-ownership access denied for workflows");
            return null;
        }

        return ownedIds;
    }

    /**
     * Verifies that a given user owns the media asset (or, as documented legacy
     * behavior, the workflow having the same ID).
     *
     * Fail-closed contract, matching ProjectReadService._verifyMediaOwnership:
     * - owned by userId → true
     * - owned by someone else, or the record has no owner → false
     * - record does not exist → false
     * - database failure → throws (an infrastructure fault is never a "yes")
     */
    async verifyMediaOwnership(mediaId, userId, req = null) {
        if (!mediaId) return false;
        if (this._isBypassed(req)) return true;

        let media;
        try {
            media = await this.db.media.findMediaOwnershipRecord(mediaId);
        } catch (mediaError) {
            authLogger.error({ event: "workflow_auth.media_lookup_error", err: mediaError.message, userId, mediaId }, "verifyMediaOwnership media lookup error");
            throw mediaError;
        }

        if (media) {
            if (media.project?.user_id === userId) {
                return true;
            }
            authLogger.warn({ event: "workflow_auth.media_access_denied", userId, mediaId, owner: media.project?.user_id ?? null }, "Foreign or ownerless media access denied");
            return false;
        }

        // mediaId may refer to a workflow container (documented legacy alias).
        const { data: wf, error: wfError } = await this.db.workflows.client()
            .from("workflow")
            .select("id, project:project!project_id(user_id)")
            .eq("id", mediaId)
            .maybeSingle();

        if (wfError) {
            authLogger.error({ event: "workflow_auth.wf_lookup_error", err: wfError.message, userId, mediaId }, "verifyMediaOwnership workflow lookup error");
            throw wfError;
        }

        if (wf) {
            if (wf.project?.user_id === userId) {
                return true;
            }
            authLogger.warn({ event: "workflow_auth.wf_access_denied", userId, workflowId: mediaId, owner: wf.project?.user_id ?? null }, "Foreign or ownerless workflow access denied");
            return false;
        }

        authLogger.warn({ event: "workflow_auth.media_missing", userId, mediaId }, "Media/workflow not found; denying request (fail-closed)");
        return false;
    }
}

export default WorkflowAuthorizationService;
