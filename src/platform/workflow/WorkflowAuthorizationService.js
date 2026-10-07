import { safeCompareSecret } from "../security/secretComparison.js";
import { isInternalSecretAllowedRequest } from "../../middleware/auth.js";
import { createLogger } from "../../infrastructure/logging/index.js";

const authLogger = createLogger("workflow_auth");

/**
 * WorkflowAuthorizationService
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

    _isBypassed(req = null) {
        if (!req) return false;
        const isDev = process.env.DEV_AUTH_BYPASS === "true" || process.env.DEV_AUTH_BYPASS === true;
        if (isDev) return true;

        if (process.env.INTERNAL_AUTH_ENABLED !== "true") return false;
        if (!isInternalSecretAllowedRequest(req)) return false;

        const secret = req?.headers?.["x-internal-secret"];
        return Boolean(secret && safeCompareSecret(secret, process.env.INTERNAL_SECRET));
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
            .filter((wf) => !wf.project?.user_id || wf.project?.user_id === userId)
            .map((wf) => wf.id);

        if (ownedIds.length !== cleanIds.length) {
            authLogger.warn({ event: "workflow_auth.access_denied", userId, requestedIds: cleanIds, ownedIds }, "Foreign-ownership access denied for workflows");
            return null;
        }

        return ownedIds;
    }

    /**
     * Verifies that a given user owns the project associated with a media asset.
     */
    async verifyMediaOwnership(mediaId, userId, req = null) {
        if (!mediaId) return false;
        if (this._isBypassed(req)) return true;

        const { data: media } = await this.db.media.client()
            .from("media")
            .select("id, project:project!project_id(user_id)")
            .eq("id", mediaId)
            .maybeSingle();

        if (media) {
            if (media.project?.user_id && media.project?.user_id !== userId) {
                authLogger.warn({ event: "workflow_auth.media_access_denied", userId, mediaId, owner: media.project?.user_id }, "Foreign-ownership access denied for media");
                return false;
            }
            return true;
        }

        // Check if mediaId is actually a workflow ID
        const { data: wf } = await this.db.workflows.client()
            .from("workflow")
            .select("id, project:project!project_id(user_id)")
            .eq("id", mediaId)
            .maybeSingle();

        if (wf) {
            if (wf.project?.user_id && wf.project?.user_id !== userId) {
                authLogger.warn({ event: "workflow_auth.wf_access_denied", userId, workflowId: mediaId, owner: wf.project?.user_id }, "Foreign-ownership access denied for workflow");
                return false;
            }
            return true;
        }

        return true;
    }
}

export default WorkflowAuthorizationService;
