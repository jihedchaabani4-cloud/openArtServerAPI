import { BaseRepository } from "./BaseRepository.js";
import { inferWorkflowMediaRole } from "./workflowMediaRole.js";

export class WorkflowMediaRepository extends BaseRepository {
    constructor() {
        super("workflow_media");
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
        const { data, error } = await this.client()
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

        const { data, error } = await this.client()
            .from(this.tableName)
            .upsert(rows, { onConflict: "workflow_id,media_id,role" })
            .select();
        if (error) throw error;
        return data || [];
    }

    async findByWorkflow(workflowId) {
        if (!workflowId) return [];
        const { data, error } = await this.client()
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
        const { data, error } = await this.client()
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
        const { data, error } = await this.client()
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
        const { data, error } = await this.client()
            .from(this.tableName)
            .select("workflow_id")
            .eq("workflow_id", resolvedWorkflowId)
            .eq("media_id", resolvedMediaId)
            .limit(1);
        if (error) throw error;
        return (data || []).length > 0;
    }

    async unlink({ workflowId, workflow_id, mediaId, media_id, role = null }) {
        const resolvedWorkflowId = workflowId || workflow_id;
        const resolvedMediaId = mediaId || media_id;
        if (!resolvedWorkflowId || !resolvedMediaId) return;

        let query = this.client()
            .from(this.tableName)
            .delete()
            .eq("workflow_id", resolvedWorkflowId)
            .eq("media_id", resolvedMediaId);

        const normalizedRole = role ? inferWorkflowMediaRole({ role }) : null;
        if (normalizedRole) query = query.eq("role", normalizedRole);

        const { error } = await query;
        if (error) throw error;
    }

    async unlinkByWorkflow(workflowId) {
        if (!workflowId) return;
        const { error } = await this.client()
            .from(this.tableName)
            .delete()
            .eq("workflow_id", workflowId);
        if (error) throw error;
    }

    async unlinkByMedia(mediaId) {
        if (!mediaId) return;
        const { error } = await this.client()
            .from(this.tableName)
            .delete()
            .eq("media_id", mediaId);
        if (error) throw error;
    }

    async countLinksForMedia(mediaId) {
        if (!mediaId) return 0;
        const { count, error } = await this.client()
            .from(this.tableName)
            .select("media_id", { count: "exact", head: true })
            .eq("media_id", mediaId);
        if (error) throw error;
        return count || 0;
    }
}
