/**
 * TenantAccessService
 * Platform Service — project ownership enforcement.
 *
 * Feature: 026-backend-platform-layer-refactor
 * Layer: Platform (src/platform/security/)
 * Pattern: Single ProjectRepository lookup; throws 403 on mismatch.
 */

import { randomUUID } from "node:crypto";
import { createLogger } from "../../infrastructure/logging/index.js";

const securityLogger = createLogger("security");

function log(operation, status, meta = {}) {
    const level = status === "denied" || status === "error" ? "warn" : "debug";
    securityLogger[level]({
        operation: `TenantAccessService.${operation}`,
        status,
        ...meta,
    }, `TenantAccess.${operation}: ${status}`);
}

export class TenantAccessService {
    /**
     * @param {Object} deps
     * @param {import("../../db/ProjectRepository.js").ProjectRepository} deps.db.projects
     */
    constructor({ db }) {
        this.projects = db.projects;
    }

    /**
     * Asserts that userId owns the given projectId.
     * Throws 403 if project is not found or user_id does not match.
     *
     * @param {string} userId
     * @param {string} projectId
     * @throws {Error} with statusCode 403 or 404
     */
    async assertProjectOwnership(userId, projectId) {
        const traceId = randomUUID();

        const project = await this.projects.findById(projectId, "id, user_id");

        if (!project) {
            const err = new Error(`Project not found: ${projectId}`);
            err.statusCode = 404;
            log("assertProjectOwnership", "not_found", { traceId, userId, projectId });
            throw err;
        }

        if (project.user_id !== userId) {
            // Allow dev bypass for local development
            if (process.env.DEV_AUTH_BYPASS === "true") {
                log("assertProjectOwnership", "bypassed", { traceId, userId, projectId });
                return;
            }
            const err = new Error(`Forbidden: user '${userId}' does not own project '${projectId}'`);
            err.statusCode = 403;
            log("assertProjectOwnership", "forbidden", { traceId, userId, projectId });
            throw err;
        }

        log("assertProjectOwnership", "allowed", { traceId, userId, projectId });
    }
}
