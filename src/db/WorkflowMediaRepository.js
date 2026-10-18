import { BaseRepository } from "./BaseRepository.js";
import { inferWorkflowMediaRole } from "./workflowMediaRole.js";

const memoryWorkflowMedia = [];

export class WorkflowMediaRepository extends BaseRepository {
    static _testMemoryEnabled = false;

    static enableTestMemoryFallback() {
        if (process.env.NODE_ENV !== "test") {
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

    constructor() {
        super("workflow_media");
    }

    _isMemoryMode() {
        if (process.env.NODE_ENV !== "test") {
            return false;
        }
        return Boolean(WorkflowMediaRepository._testMemoryEnabled);
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
    async linkMedia({ workflowId, workflow_id, mediaId, media_id, role, stepId, step_id, workflowType, workflow_type }) {
        const resolvedWorkflowId = workflowId || workflow_id;
        const resolvedMediaId = mediaId || media_id;
        if (!resolvedWorkflowId || !resolvedMediaId) return null;

        const resolvedRole = inferWorkflowMediaRole({ role, stepId, step_id, workflowType, workflow_type });

        if (this._isMemoryMode()) {
            const idx = memoryWorkflowMedia.findIndex(
                (m) => m.workflow_id === resolvedWorkflowId && m.media_id === resolvedMediaId && m.role === resolvedRole
            );
            const row = {
                workflow_id: resolvedWorkflowId,
                media_id: resolvedMediaId,
                role: resolvedRole,
                created_at: new Date().toISOString(),
            };
            if (idx >= 0) {
                memoryWorkflowMedia[idx] = row;
            } else {
                memoryWorkflowMedia.push(row);
            }
            return row;
        }

        const { data, error } = await this._getClientOrThrow()
            .from(this.tableName)
            .upsert({
                workflow_id: resolvedWorkflowId,
                media_id: resolvedMediaId,
                role: resolvedRole,
            }, { onConflict: "workflow_id,media_id,role" })
            .select()
            .single();
        if (error) throw error;
        return data;
    }

    async createMediaInWorkflow(params = {}) {
        return this.linkMedia(params);
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
                    workflow_id: row.workflow_id,
                    workflowId: row.workflow_id,
                    role: row.role,
                    mediaRole: row.role,
                    workflow_media_created_at: row.created_at,
                }));
        }
        const { data, error } = await this._getClientOrThrow()
            .from(this.tableName)
            .select(`
                workflow_id,
                media_id,
                role,
                created_at,
                media:media_id (*)
            `)
            .eq("workflow_id", workflowId)
            .order("created_at", { ascending: true });
        if (error) throw error;
        return (data || []).map((row) => ({
            ...(row.media || {}),
            workflow_id: row.workflow_id,
            workflowId: row.workflow_id,
            role: row.role,
            mediaRole: row.role,
            workflow_media_created_at: row.created_at,
        }));
    }

    async findByWorkflowIds(workflowIds = []) {
        const ids = Array.isArray(workflowIds) ? [...new Set(workflowIds.filter(Boolean))] : [];
        if (ids.length === 0) return [];
        const { data, error } = await this._getClientOrThrow()
            .from(this.tableName)
            .select(`
                workflow_id,
                media_id,
                role,
                created_at,
                media:media_id (
                    id,
                    generation_config_id,
                    step_id,
                    url,
                    width,
                    height,
                    status,
                    error_message,
                    create_time
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
                    workflow_id: row.workflow_id,
                    workflowId: row.workflow_id,
                    role: row.role,
                    mediaRole: row.role,
                    workflow_media_created_at: row.created_at,
                };
            })
            .filter(Boolean);
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
}
