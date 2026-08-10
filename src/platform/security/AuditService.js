/**
 * AuditService
 * Platform Service — fire-and-forget audit event logging.
 *
 * Feature: 026-backend-platform-layer-refactor
 * Layer: Platform (src/platform/security/)
 * Pattern: Fire-and-forget insert to audit_log via supabaseAdmin.
 *          Never throws — failures are logged to console only.
 *          Structured log emitted for every call (FR-011).
 *
 * SQL to create audit_log table in Supabase:
 * ─────────────────────────────────────────────────────────────
 * CREATE TABLE IF NOT EXISTS audit_log (
 *   id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *   action       TEXT NOT NULL,
 *   user_id      TEXT,
 *   resource_type TEXT,
 *   resource_id  TEXT,
 *   metadata     JSONB,
 *   create_time  TIMESTAMPTZ NOT NULL DEFAULT now()
 * );
 * ─────────────────────────────────────────────────────────────
 */

import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

// ── Structured log helper (FR-011) ───────────────────────────────────────────
function log(operation, status, meta = {}) {
    console.log(JSON.stringify({
        timestamp: new Date().toISOString(),
        operation: `AuditService.${operation}`,
        status,
        ...meta,
    }));
}

// ── Lazy admin client (only created if env vars are present) ─────────────────
let _adminClient = null;
function getAdminClient() {
    if (_adminClient) return _adminClient;
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
    if (!url || !key) return null;
    _adminClient = createClient(url, key);
    return _adminClient;
}

export class AuditService {
    /**
     * Fire-and-forget audit event. Never throws.
     *
     * @param {Object} params
     * @param {string}  params.action        - e.g. "generation.delete", "element.create"
     * @param {string}  [params.userId]      - authenticated user ID
     * @param {string}  [params.resourceType] - e.g. "workflow", "element", "project"
     * @param {string}  [params.resourceId]  - UUID of the affected resource
     * @param {Object}  [params.metadata]    - arbitrary JSON metadata
     */
    log({ action, userId = null, resourceType = null, resourceId = null, metadata = {} }) {
        const traceId = randomUUID();

        // Emit structured console log immediately (synchronous)
        log("log", "emitted", { traceId, action, userId, resourceType, resourceId });

        // Fire-and-forget DB insert (async, non-blocking)
        const adminClient = getAdminClient();
        if (adminClient) {
            adminClient
                .from("audit_log")
                .insert({
                    action,
                    user_id: userId,
                    resource_type: resourceType,
                    resource_id: resourceId,
                    metadata,
                })
                .then(({ error }) => {
                    if (error) {
                        console.warn(`[AuditService] DB insert failed for action '${action}':`, error.message);
                    }
                })
                .catch((err) => {
                    console.warn(`[AuditService] Unexpected error for action '${action}':`, err.message);
                });
        } else {
            console.warn(`[AuditService] No admin client available — audit_log insert skipped for action '${action}'`);
        }
    }
}
