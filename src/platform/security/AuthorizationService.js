/**
 * AuthorizationService
 * Platform Service — static RBAC permission checks.
 *
 * Feature: 026-backend-platform-layer-refactor
 * Layer: Platform (src/platform/security/)
 * Principle V (YAGNI): simple static role map; no Redis/ABAC complexity
 */

import { randomUUID } from "node:crypto";

// ── Structured log helper (FR-011) ───────────────────────────────────────────
function log(operation, status, meta = {}) {
    console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        operation: `AuthorizationService.${operation}`,
        status,
        ...meta,
    }));
}

// ── Static RBAC permission map ───────────────────────────────────────────────
// Format: role → Set of allowed actions
const ROLE_PERMISSIONS = {
    owner: new Set([
        "project:read", "project:write", "project:delete",
        "generation:read", "generation:write", "generation:delete",
        "element:read", "element:write", "element:delete",
        "character:read", "character:write", "character:delete",
        "billing:read",
    ]),
    viewer: new Set([
        "project:read",
        "generation:read",
        "element:read",
        "character:read",
    ]),
};

export class AuthorizationService {
    /**
     * Returns true if the role is permitted to perform the action.
     * @param {string} role   - e.g. "owner" | "viewer"
     * @param {string} action - e.g. "generation:delete"
     * @returns {boolean}
     */
    can(role, action) {
        const permissions = ROLE_PERMISSIONS[role];
        const allowed = !!(permissions && permissions.has(action));
        log("can", "checked", { role, action, allowed });
        return allowed;
    }

    /**
     * Asserts the role is permitted to perform the action.
     * Throws 403 if not.
     * @param {string} role
     * @param {string} action
     * @throws {Error} with statusCode 403
     */
    assertCan(role, action) {
        if (!this.can(role, action)) {
            const err = new Error(`Forbidden: role '${role}' cannot perform '${action}'`);
            err.statusCode = 403;
            log("assertCan", "forbidden", { role, action });
            throw err;
        }
        log("assertCan", "allowed", { role, action });
    }
}
