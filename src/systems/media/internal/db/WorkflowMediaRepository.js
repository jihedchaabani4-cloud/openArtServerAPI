import { BaseRepository } from "../../../../db/BaseRepository.js";
import { supabaseAdmin } from "./mediaClient.js";
import { inferWorkflowMediaRole } from "./workflowMediaRole.js";
import { formatWorkflowReferenceQuotaMessage } from "../ingestion/MediaUploadErrors.js";
import { envConfig } from "#shared";

const memoryWorkflowMedia = [];

export class WorkflowMediaRepository extends BaseRepository {
    static _testMemoryEnabled = false;

    static enableTestMemoryFallback() {
        if (!envConfig.isTest) {
            throw new Error("WorkflowMediaRepository in-memory fallback is prohibited outside NODE_ENV=test");
        }
        WorkflowMediaRepository._testMemoryEnabled = true;
    }

    static disableTestMemoryFallback() {
        WorkflowMediaRepository._testMemoryEnabled = false;
        memoryWorkflowMedia.length = 0;
    }

    static get useMemoryFallback() {
        return WorkflowMediaRepository._testMemoryEnabled;
    }

    static set useMemoryFallback(val) {
        if (val) {
            WorkflowMediaRepository.enableTestMemoryFallback();
        } else {
            WorkflowMediaRepository.disableTestMemoryFallback();
        }
    }

    static clearMemory() {
        memoryWorkflowMedia.length = 0;
    }

    static getMemoryStore() {
        return memoryWorkflowMedia;
    }

    constructor() {
        super("workflow_media");
    }

    _isMemoryMode() {
        if (!envConfig.isTest) {
            return false;
        }
        if (Object.prototype.hasOwnProperty.call(this, "client")) {
            return false;
        }
        return Boolean(WorkflowMediaRepository._testMemoryEnabled);
    }

    client() {
        return supabaseAdmin || super.client();
    }

    _getClientOrThrow() {
        const client = this.client();
        if (!client || typeof client.from !== "function") {
            throw new Error("WorkflowMediaRepository: Database client is not wired (production requires a valid database client)");
        }
        return client;
    }

    /**
     * Link one media row to one workflow with a semantic role.
     * Repository owns only persistence; services own authorization and project checks.
     */
    async linkMedia({
        workflowId,
        workflow_id,
        mediaId,
        media_id,
        role,
        stepId,
        step_id,
        workflowType,
        workflow_type,
        is_primary,
        isPrimary,
        metadata,
    }) {
        const resolvedWorkflowId = workflowId || workflow_id;
        const resolvedMediaId = mediaId || media_id;
        if (!resolvedWorkflowId || !resolvedMediaId) return null;

        const resolvedRole = inferWorkflowMediaRole({ role, stepId, step_id, workflowType, workflow_type });
        const resolvedIsPrimary = Boolean(is_primary ?? isPrimary ?? false);
        const resolvedMetadata = (metadata && typeof metadata === "object") ? metadata : {};

        if (this._isMemoryMode()) {
            const hasExistingPrimary = memoryWorkflowMedia.some(
                (m) => m.workflow_id === resolvedWorkflowId && m.media_id !== resolvedMediaId && m.is_primary === true
            );
            const actualIsPrimary = resolvedIsPrimary && !hasExistingPrimary;
            const idx = memoryWorkflowMedia.findIndex(
                (m) => m.workflow_id === resolvedWorkflowId && m.media_id === resolvedMediaId && m.role === resolvedRole
            );
            const row = {
                workflow_id: resolvedWorkflowId,
                media_id: resolvedMediaId,
                role: resolvedRole,
                is_primary: actualIsPrimary,
                metadata: resolvedMetadata,
                created_at: new Date().toISOString(),
            };
            if (idx >= 0) {
                memoryWorkflowMedia[idx] = row;
            } else {
                memoryWorkflowMedia.push(row);
            }
            return row;
        }

        const client = this._getClientOrThrow();
        if (resolvedIsPrimary) {
            await client
                .from(this.tableName)
                .update({ is_primary: false })
                .eq("workflow_id", resolvedWorkflowId)
                .eq("is_primary", true)
                .neq("media_id", resolvedMediaId);
        }

        const { data, error } = await client
            .from(this.tableName)
            .upsert({
                workflow_id: resolvedWorkflowId,
                media_id: resolvedMediaId,
                role: resolvedRole,
                is_primary: resolvedIsPrimary,
                metadata: resolvedMetadata,
            }, { onConflict: "workflow_id,media_id,role" })
            .select()
            .single();
        if (error) throw error;
        return data;
    }

    async createMediaInWorkflow(params = {}) {
        return this.linkMedia(params);
    }

    /**
     * Atomically attach an existing media item to a workflow without domain-specific quota enforcement.
     * Coordinates with concurrent unlink and orphan-reaping using row-level locking.
     */
    async attachMedia({
        workflowId,
        workflow_id,
        mediaId,
        media_id,
        role = "detail",
        maxAllowed = null,
        autoPrimary = true,
    } = {}) {
        return this.attachReferenceMedia({
            workflowId,
            workflow_id,
            mediaId,
            media_id,
            role,
            maxAllowed,
            autoPrimary,
        });
    }

    /**
     * Atomically attach a reference media item to a workflow.
     * Invokes the atomic RPC attach_workflow_reference_media to lock the media row FOR KEY SHARE
     * and serialize attachments on the workflow, enforcing the maximum reference quota.
     */
    async attachReferenceMedia({
        workflowId,
        workflow_id,
        mediaId,
        media_id,
        role = "detail",
        maxAllowed = null,
        autoPrimary = true,
    } = {}) {
        const resolvedWorkflowId = workflowId || workflow_id;
        const resolvedMediaId = mediaId || media_id;
        if (!resolvedWorkflowId || !resolvedMediaId) return null;

        const resolvedRole = inferWorkflowMediaRole({ role });

        if (this._isMemoryMode()) {
            const currentRelations = memoryWorkflowMedia.filter(
                (m) => m.workflow_id === resolvedWorkflowId && m.role === resolvedRole
            );
            const existingRelation = currentRelations.find((m) => m.media_id === resolvedMediaId);
            const exists = Boolean(existingRelation);

            const hasQuota = maxAllowed !== null && maxAllowed !== undefined;
            if (hasQuota && !exists && currentRelations.length >= maxAllowed) {
                const err = new Error(formatWorkflowReferenceQuotaMessage(maxAllowed, currentRelations.length));
                err.code = "23514";
                err.statusCode = 400;
                throw err;
            }

            if (!exists) {
                const autoPrimaryEffective = autoPrimary === undefined || autoPrimary === null ? true : Boolean(autoPrimary);
                let shouldBePrimary = false;
                if (autoPrimaryEffective) {
                    const hasPrimary = memoryWorkflowMedia.some(
                        (m) => m.workflow_id === resolvedWorkflowId && m.is_primary === true
                    );
                    shouldBePrimary = !hasPrimary;
                }
                const row = {
                    workflow_id: resolvedWorkflowId,
                    media_id: resolvedMediaId,
                    role: resolvedRole,
                    is_primary: shouldBePrimary,
                    metadata: {},
                    created_at: new Date().toISOString(),
                };
                memoryWorkflowMedia.push(row);

                return {
                    workflow_id: resolvedWorkflowId,
                    media_id: resolvedMediaId,
                    role: resolvedRole,
                    is_primary: shouldBePrimary,
                    current_count: currentRelations.length + 1,
                    max_allowed: maxAllowed,
                    is_existing: false,
                };
            }

            return {
                workflow_id: resolvedWorkflowId,
                media_id: resolvedMediaId,
                role: resolvedRole,
                is_primary: Boolean(existingRelation.is_primary),
                current_count: currentRelations.length,
                max_allowed: maxAllowed,
                is_existing: true,
            };
        }

        const client = this._getClientOrThrow();
        if (typeof client.rpc !== "function") {
            // Client has no RPC capability — fail closed; linkMedia bypasses locking protocol
            const unavailableErr = new Error("Atomic media attach RPC 'attach_workflow_reference_media' is unavailable");
            unavailableErr.code = "ATTACH_RPC_UNAVAILABLE";
            unavailableErr.statusCode = 503;
            throw unavailableErr;
        }

        const rpcParams = {
            p_workflow_id: resolvedWorkflowId,
            p_media_id: resolvedMediaId,
            p_role: resolvedRole,
            p_max_allowed: maxAllowed,
        };
        if (autoPrimary === false) {
            rpcParams.p_auto_primary = false;
        }

        const { data, error } = await client.rpc("attach_workflow_reference_media", rpcParams);
        if (!error && data) {
            return data;
        }
        if (error) {
            // Strict classification: ONLY PostgreSQL 42883 or PostgREST PGRST202 for this specific function
            const isMissingFunction = error.code === "42883"
                || (typeof error.message === "string" && (
                    error.message.includes("attach_workflow_reference_media") &&
                    (error.message.includes("Could not find the function") || error.message.includes("does not exist"))
                ));
            if (isMissingFunction) {
                // Fail closed — a linkMedia() fallback would bypass the FOR KEY SHARE locking protocol
                const unavailableErr = new Error("Atomic media attach RPC 'attach_workflow_reference_media' is unavailable");
                unavailableErr.code = "ATTACH_RPC_UNAVAILABLE";
                unavailableErr.statusCode = 503;
                throw unavailableErr;
            }
            // Any other database/schema error (e.g. 42703 undefined_column) must propagate
            throw error;
        }

        // RPC returned success but data was falsy — treat as attach success without a full record
        return { workflow_id: resolvedWorkflowId, media_id: resolvedMediaId, role: resolvedRole };
    }

    async setPrimaryMedia({ workflowId, workflow_id, mediaId, media_id }) {
        const resolvedWorkflowId = workflowId || workflow_id;
        const resolvedMediaId = mediaId || media_id;
        if (!resolvedWorkflowId || !resolvedMediaId) return null;

        if (this._isMemoryMode()) {
            let found = false;
            for (const item of memoryWorkflowMedia) {
                if (item.workflow_id === resolvedWorkflowId) {
                    if (item.media_id === resolvedMediaId) {
                        item.is_primary = true;
                        found = true;
                    } else {
                        item.is_primary = false;
                    }
                }
            }
            if (!found) {
                const newRow = {
                    workflow_id: resolvedWorkflowId,
                    media_id: resolvedMediaId,
                    role: "output",
                    is_primary: true,
                    metadata: {},
                    created_at: new Date().toISOString(),
                };
                memoryWorkflowMedia.push(newRow);
                return newRow;
            }
            return {
                workflow_id: resolvedWorkflowId,
                media_id: resolvedMediaId,
                is_primary: true,
            };
        }

        const client = this._getClientOrThrow();

        if (typeof client.rpc !== "function") {
            const unavailableErr = new Error("Atomic primary media switch RPC 'set_workflow_primary_media' is unavailable");
            unavailableErr.code = "RPC_UNAVAILABLE";
            unavailableErr.statusCode = 503;
            throw unavailableErr;
        }

        const { data: rpcData, error: rpcErr } = await client.rpc("set_workflow_primary_media", {
            p_workflow_id: resolvedWorkflowId,
            p_media_id: resolvedMediaId,
        });
        if (!rpcErr && rpcData) {
            return rpcData;
        }
        if (rpcErr) {
            const isMissingFunction = rpcErr.code === "42883"
                || rpcErr.message?.includes("function")
                || rpcErr.message?.includes("does not exist");
            if (isMissingFunction) {
                const unavailableErr = new Error("Atomic primary media switch RPC 'set_workflow_primary_media' is unavailable");
                unavailableErr.code = "RPC_UNAVAILABLE";
                unavailableErr.statusCode = 503;
                throw unavailableErr;
            }
            throw rpcErr;
        }
        return { workflow_id: resolvedWorkflowId, media_id: resolvedMediaId, is_primary: true };
    }

    /**
     * Atomically claims the primary media slot if and only if no primary media exists.
     * Guarantees "first successful attachment wins" without replacing an established Cover.
     */
    async setPrimaryMediaIfNone({ workflowId, workflow_id, mediaId, media_id }) {
        const resolvedWorkflowId = workflowId || workflow_id;
        const resolvedMediaId = mediaId || media_id;
        if (!resolvedWorkflowId || !resolvedMediaId) return false;

        if (this._isMemoryMode()) {
            const hasPrimary = memoryWorkflowMedia.some(
                (m) => m.workflow_id === resolvedWorkflowId && m.is_primary === true
            );
            if (hasPrimary) return false;

            const target = memoryWorkflowMedia.find(
                (m) => m.workflow_id === resolvedWorkflowId && m.media_id === resolvedMediaId
            );
            if (target) {
                target.is_primary = true;
                return true;
            }
            return false;
        }

        const client = this._getClientOrThrow();

        // Preferred atomic path: RPC in single transaction with row locking
        if (typeof client.rpc === "function") {
            try {
                const { data: rpcData, error: rpcErr } = await client.rpc("set_workflow_primary_media_if_none", {
                    p_workflow_id: resolvedWorkflowId,
                    p_media_id: resolvedMediaId,
                });
                if (!rpcErr && rpcData) {
                    return Boolean(rpcData.is_primary ?? rpcData.established);
                }
            } catch (_) {}
        }

        // Database client fallback: verify no primary currently exists
        const existingPrimary = await this.getPrimaryMedia(resolvedWorkflowId);
        if (existingPrimary) {
            return false;
        }

        try {
            const { data, error } = await client
                .from(this.tableName)
                .update({ is_primary: true })
                .eq("workflow_id", resolvedWorkflowId)
                .eq("media_id", resolvedMediaId)
                .select()
                .maybeSingle();

            if (error) {
                if (error.code === "23505") return false;
                throw error;
            }
            return Boolean(data);
        } catch (err) {
            if (err.code === "23505" || err.message?.includes("idx_workflow_media_single_primary")) {
                return false;
            }
            throw err;
        }
    }

    async clearPrimaryMedia({ workflowId, workflow_id }) {
        const resolvedWorkflowId = workflowId || workflow_id;
        if (!resolvedWorkflowId) return;

        if (this._isMemoryMode()) {
            for (const item of memoryWorkflowMedia) {
                if (item.workflow_id === resolvedWorkflowId) {
                    item.is_primary = false;
                }
            }
            return;
        }

        const { error } = await this._getClientOrThrow()
            .from(this.tableName)
            .update({ is_primary: false })
            .eq("workflow_id", resolvedWorkflowId)
            .eq("is_primary", true);

        if (error) throw error;
    }

    async getPrimaryMedia(workflowId) {
        if (!workflowId) return null;
        if (this._isMemoryMode()) {
            const found = memoryWorkflowMedia.find(
                (m) => m.workflow_id === workflowId && m.is_primary === true
            );
            return found || null;
        }
        const { data, error } = await this._getClientOrThrow()
            .from(this.tableName)
            .select(`
                workflow_id,
                media_id,
                role,
                is_primary,
                metadata,
                created_at,
                media:media_id (*)
            `)
            .eq("workflow_id", workflowId)
            .eq("is_primary", true)
            .limit(1)
            .maybeSingle();

        if (error) throw error;
        if (!data) return null;
        const media = Array.isArray(data.media) ? data.media[0] : data.media;
        return {
            ...(media || {}),
            workflow_id: data.workflow_id,
            workflowId: data.workflow_id,
            role: data.role,
            mediaRole: data.role,
            is_primary: true,
            isPrimary: true,
            metadata: data.metadata || {},
            workflow_media_created_at: data.created_at,
        };
    }

    async linkMany({ workflowId, workflow_id, mediaIds = [], role, stepId, step_id, workflowType, workflow_type }) {
        const resolvedWorkflowId = workflowId || workflow_id;
        const ids = Array.isArray(mediaIds) ? mediaIds.filter(Boolean) : [];
        if (!resolvedWorkflowId || ids.length === 0) return [];

        const resolvedRole = inferWorkflowMediaRole({ role, stepId, step_id, workflowType, workflow_type });
        const rows = ids.map((mediaId) => ({
            workflow_id: resolvedWorkflowId,
            media_id: mediaId,
            role: resolvedRole,
            is_primary: false,
            metadata: {},
        }));

        if (this._isMemoryMode()) {
            return rows.map((r) => {
                const idx = memoryWorkflowMedia.findIndex(
                    (m) => m.workflow_id === r.workflow_id && m.media_id === r.media_id && m.role === r.role
                );
                const row = { ...r, created_at: new Date().toISOString() };
                if (idx >= 0) memoryWorkflowMedia[idx] = row;
                else memoryWorkflowMedia.push(row);
                return row;
            });
        }

        const { data, error } = await this._getClientOrThrow()
            .from(this.tableName)
            .upsert(rows, { onConflict: "workflow_id,media_id,role" })
            .select();
        if (error) throw error;
        return data || [];
    }

    async findByWorkflow(workflowId) {
        if (!workflowId) return [];
        if (this._isMemoryMode()) {
            return memoryWorkflowMedia
                .filter((m) => m.workflow_id === workflowId)
                .map((row) => ({
                    id: row.media_id,
                    media_id: row.media_id,
                    workflow_id: row.workflow_id,
                    workflowId: row.workflow_id,
                    role: row.role,
                    mediaRole: row.role,
                    is_primary: Boolean(row.is_primary),
                    isPrimary: Boolean(row.is_primary),
                    metadata: row.metadata || {},
                    workflow_media_created_at: row.created_at,
                }));
        }
        const { data, error } = await this._getClientOrThrow()
            .from(this.tableName)
            .select(`
                workflow_id,
                media_id,
                role,
                is_primary,
                metadata,
                created_at,
                media:media_id (*)
            `)
            .eq("workflow_id", workflowId)
            .order("created_at", { ascending: true });
        if (error) throw error;
        return (data || []).map((row) => ({
            ...(row.media || {}),
            id: row.media?.id || row.media_id,
            media_id: row.media_id,
            workflow_id: row.workflow_id,
            workflowId: row.workflow_id,
            role: row.role,
            mediaRole: row.role,
            is_primary: Boolean(row.is_primary),
            isPrimary: Boolean(row.is_primary),
            metadata: row.metadata || {},
            workflow_media_created_at: row.created_at,
        }));
    }

    async findByWorkflowIds(workflowIds = []) {
        const ids = Array.isArray(workflowIds) ? [...new Set(workflowIds.filter(Boolean))] : [];
        if (ids.length === 0) return [];
        if (this._isMemoryMode()) {
            return memoryWorkflowMedia
                .filter((m) => ids.includes(m.workflow_id))
                .map((row) => ({
                    id: row.media_id,
                    media_id: row.media_id,
                    workflow_id: row.workflow_id,
                    workflowId: row.workflow_id,
                    role: row.role,
                    mediaRole: row.role,
                    is_primary: Boolean(row.is_primary),
                    isPrimary: Boolean(row.is_primary),
                    metadata: row.metadata || {},
                    workflow_media_created_at: row.created_at,
                }));
        }
        const { data, error } = await this._getClientOrThrow()
            .from(this.tableName)
            .select(`
                workflow_id,
                media_id,
                role,
                is_primary,
                metadata,
                created_at,
                media:media_id (
                    id,
                    step_id,
                    url,
                    width,
                    height,
                    status,
                    error_message,
                    create_time,
                    generation_config
                )
            `)
            .in("workflow_id", ids)
            .order("created_at", { ascending: true });
        if (error) throw error;
        return (data || [])
            .map((row) => {
                const media = Array.isArray(row.media) ? row.media[0] : row.media;
                if (!media) return null;
                return {
                    ...media,
                    id: media.id || row.media_id,
                    media_id: row.media_id,
                    mediaId: row.media_id,
                    workflow_id: row.workflow_id,
                    workflowId: row.workflow_id,
                    role: row.role,
                    mediaRole: row.role,
                    is_primary: Boolean(row.is_primary),
                    isPrimary: Boolean(row.is_primary),
                    metadata: row.metadata || {},
                    workflow_media_created_at: row.created_at,
                };
            })
            .filter(Boolean);
    }

    async findRelationsByWorkflowIds(workflowIds = []) {
        const ids = Array.isArray(workflowIds) ? [...new Set(workflowIds.filter(Boolean))] : [];
        if (ids.length === 0) return [];
        if (this._isMemoryMode()) {
            return memoryWorkflowMedia
                .filter((m) => ids.includes(m.workflow_id))
                .map((r) => ({
                    workflow_id: r.workflow_id,
                    media_id: r.media_id,
                    role: r.role,
                    is_primary: Boolean(r.is_primary),
                    metadata: r.metadata || {},
                    created_at: r.created_at,
                }));
        }
        const { data, error } = await this._getClientOrThrow()
            .from(this.tableName)
            .select("workflow_id, media_id, role, is_primary, metadata, created_at")
            .in("workflow_id", ids);
        if (error) throw error;
        return data || [];
    }

    async findByMedia(mediaId) {
        if (!mediaId) return [];
        if (this._isMemoryMode()) {
            return memoryWorkflowMedia
                .filter((m) => m.media_id === mediaId)
                .map((r) => ({
                    workflow_id: r.workflow_id,
                    media_id: r.media_id,
                    role: r.role,
                    created_at: r.created_at,
                }));
        }
        const { data, error } = await this._getClientOrThrow()
            .from(this.tableName)
            .select("workflow_id, media_id, role, created_at")
            .eq("media_id", mediaId)
            .order("created_at", { ascending: true });
        if (error) throw error;
        return data || [];
    }

    async isMediaLinkedToWorkflow({ workflowId, workflow_id, mediaId, media_id }) {
        const resolvedWorkflowId = workflowId || workflow_id;
        const resolvedMediaId = mediaId || media_id;
        if (!resolvedWorkflowId || !resolvedMediaId) return false;
        if (this._isMemoryMode()) {
            return memoryWorkflowMedia.some(
                (m) => m.workflow_id === resolvedWorkflowId && m.media_id === resolvedMediaId
            );
        }
        const { data, error } = await this._getClientOrThrow()
            .from(this.tableName)
            .select("workflow_id")
            .eq("workflow_id", resolvedWorkflowId)
            .eq("media_id", resolvedMediaId)
            .limit(1);
        if (error) throw error;
        return (data || []).length > 0;
    }

    async unlink({ workflowId, workflow_id, mediaId, media_id, role = null } = {}) {
        const resolvedWorkflowId = workflowId || workflow_id;
        const resolvedMediaId = mediaId || media_id;
        if (!resolvedWorkflowId && !resolvedMediaId) return;

        const normalizedRole = role ? inferWorkflowMediaRole({ role }) : null;

        if (this._isMemoryMode()) {
            for (let i = memoryWorkflowMedia.length - 1; i >= 0; i--) {
                const item = memoryWorkflowMedia[i];
                const matchesWf = !resolvedWorkflowId || item.workflow_id === resolvedWorkflowId;
                const matchesMedia = !resolvedMediaId || item.media_id === resolvedMediaId;
                const matchesRole = !normalizedRole || item.role === normalizedRole;
                if (matchesWf && matchesMedia && matchesRole) {
                    memoryWorkflowMedia.splice(i, 1);
                }
            }
            return;
        }

        let query = this._getClientOrThrow()
            .from(this.tableName)
            .delete();

        if (resolvedWorkflowId) query = query.eq("workflow_id", resolvedWorkflowId);
        if (resolvedMediaId) query = query.eq("media_id", resolvedMediaId);
        if (normalizedRole) query = query.eq("role", normalizedRole);

        const { error } = await query;
        if (error) throw error;
    }

    async unlinkByWorkflow(workflowId) {
        if (!workflowId) return;
        return this.unlink({ workflowId });
    }

    async unlinkByMedia(mediaId) {
        if (!mediaId) return;
        return this.unlink({ mediaId });
    }

    async countLinksForMedia(mediaId) {
        if (!mediaId) return 0;
        if (this._isMemoryMode()) {
            return memoryWorkflowMedia.filter((m) => m.media_id === mediaId).length;
        }
        const { count, error } = await this._getClientOrThrow()
            .from(this.tableName)
            .select("media_id", { count: "exact", head: true })
            .eq("media_id", mediaId);
        if (error) throw error;
        return count || 0;
    }

    /**
     * Atomically unlink a workflow_media relation and evaluate/reap orphan media in a single transaction.
     * Uses row-level lock (FOR UPDATE) in PostgreSQL to serialize against concurrent attachments.
     *
     * Returns: { unlinked: boolean, is_orphan: boolean, storage_url: string|null, remaining_links: number, was_primary: boolean }
     */
    async unlinkAndReapOrphan({ workflowId, workflow_id, mediaId, media_id, role = null } = {}) {
        const resolvedWorkflowId = workflowId || workflow_id;
        const resolvedMediaId = mediaId || media_id;
        if (!resolvedWorkflowId || !resolvedMediaId) {
            return { unlinked: false, is_orphan: false, storage_url: null, remaining_links: 0, reason: "missing_ids" };
        }

        const normalizedRole = role ? inferWorkflowMediaRole({ role }) : null;

        if (this._isMemoryMode()) {
            const matchingIndices = [];
            let wasPrimary = false;
            for (let i = 0; i < memoryWorkflowMedia.length; i++) {
                const m = memoryWorkflowMedia[i];
                if (
                    m.workflow_id === resolvedWorkflowId &&
                    m.media_id === resolvedMediaId &&
                    (!normalizedRole || m.role === normalizedRole)
                ) {
                    matchingIndices.push(i);
                    if (m.is_primary) wasPrimary = true;
                }
            }

            if (matchingIndices.length === 0) {
                const currentRemaining = memoryWorkflowMedia.filter((m) => m.media_id === resolvedMediaId).length;
                return {
                    unlinked: false,
                    is_orphan: false,
                    storage_url: null,
                    remaining_links: currentRemaining,
                    reason: "relation_not_found",
                };
            }

            for (let i = matchingIndices.length - 1; i >= 0; i--) {
                memoryWorkflowMedia.splice(matchingIndices[i], 1);
            }

            const remaining = memoryWorkflowMedia.filter((m) => m.media_id === resolvedMediaId).length;
            const isOrphan = remaining === 0;

            return {
                unlinked: true,
                is_orphan: isOrphan,
                storage_url: null,
                remaining_links: remaining,
                was_primary: wasPrimary,
            };
        }

        const client = this._getClientOrThrow();

        // 1. Preferred atomic path: RPC in single transaction with row locking
        if (typeof client.rpc === "function") {
            const { data, error } = await client.rpc("unlink_workflow_media_and_reap_orphan", {
                p_workflow_id: resolvedWorkflowId,
                p_media_id: resolvedMediaId,
                p_role: normalizedRole,
            });
            if (!error && data) {
                return {
                    unlinked: Boolean(data.unlinked),
                    is_orphan: Boolean(data.is_orphan),
                    storage_url: data.storage_url || null,
                    remaining_links: Number(data.remaining_links || 0),
                    was_primary: Boolean(data.was_primary),
                };
            }
            if (error) {
                // Strict classification: ONLY PostgreSQL 42883 or specific PostgREST missing function error
                const isMissingFunction = error.code === "42883"
                    || (typeof error.message === "string" && (
                        error.message.includes("unlink_workflow_media_and_reap_orphan") &&
                        (error.message.includes("Could not find the function") || error.message.includes("does not exist"))
                    ));
                if (isMissingFunction) {
                    const unavailableErr = new Error("Atomic media unlink RPC 'unlink_workflow_media_and_reap_orphan' is unavailable");
                    unavailableErr.code = "RPC_UNAVAILABLE";
                    unavailableErr.statusCode = 503;
                    throw unavailableErr;
                }
                // Any other database/schema error (e.g. 42703 undefined_column, 42P01 undefined_table) must propagate
                throw error;
            }
        }

        // If atomic RPC is not callable on database client, fail closed (never authorize storage delete sequentially)
        const unavailableErr = new Error("Atomic media unlink RPC 'unlink_workflow_media_and_reap_orphan' is unavailable");
        unavailableErr.code = "RPC_UNAVAILABLE";
        unavailableErr.statusCode = 503;
        throw unavailableErr;
    }
}
