import { BaseRepository } from "./BaseRepository.js";
import { supabase } from "../../lib/supabase.js";

export class WorkflowRepository extends BaseRepository {
    constructor() {
        super("workflow");
    }

    /**
     * Creates a workflow (one variation inside a batch, or a standalone upload).
     * Repository-pure: no imports from controller layer.
     * @param {Object} data - workflow fields
     * @param {Object} [options] - extra options (e.g., select)
     */
    async createWorkflow(data, options = {}) {
        const {
            project_id, session_id, display_name, primary_media_id,
            variation_index, workflow_type,
        } = data;

        const newWorkflow = {
            project_id:       project_id       || null,
            session_id:       session_id       || null,
            display_name:     display_name     || "Untitled Workflow",
            variation_index:  variation_index  || 0,
            primary_media_id: primary_media_id || null,
        };

        if (workflow_type) newWorkflow.workflow_type = workflow_type;

        const { select = "*" } = options;

        const { data: created, error } = await supabase
            .from(this.tableName)
            .insert(newWorkflow)
            .select(select)
            .single();

        if (error) throw error;
        return created;
    }

    async getWorkflow(id) {
        const { data, error } = await supabase
            .from(this.tableName)
            .select("*")
            .eq("id", id)
            .single();
        if (error) throw error;
        return data;
    }

    /**
     * Sets the primary_media_id after the first media is created.
     * Called once per workflow after generation/upload succeeds.
     */
    async updatePrimaryMedia(workflow_id, media_id) {
        const { error } = await supabase
            .from(this.tableName)
            .update({ primary_media_id: media_id })
            .eq("id", workflow_id);
        if (error) throw error;
    }

    async findByBatch(batch_id, options = {}) {
        const { data, error } = await this.client()
            .from(this.tableName)
            .select("*")
            .eq("batch_id", batch_id)
            .order("variation_index", { ascending: true });
        if (error) throw error;
        return data;
    }

    async findBySession(session_id, options = {}) {
        const { select = "*", order = { column: "create_time", ascending: false } } = options;
        let query = supabase.from(this.tableName).select(select);
        if (order) query = query.order(order.column, { ascending: order.ascending });
        query = query.eq("session_id", session_id);
        const { data, error } = await query;
        if (error) throw error;
        return data;
    }

    async findByProject(project_id, options = {}) {
        const { select = "*", order = { column: "create_time", ascending: false } } = options;
        let query = supabase.from(this.tableName).select(select);
        if (order) query = query.order(order.column, { ascending: order.ascending });
        query = query.eq("project_id", project_id);
        const { data, error } = await query;
        if (error) throw error;
        return data;
    }

    /**
     * Resolves the primary media URL for a workflow.
     * Logic: primary_media_id > First created media
     */
    async getPrimaryMediaUrl(workflow_id) {
        const media = await this.getPrimaryMedia(workflow_id);
        return media?.url || null;
    }

    /**
     * Resolves the primary media for a workflow.
     * Logic: primary_media_id > First created media
     */
    async getPrimaryMedia(workflow_id) {
        if (!workflow_id) return null;

        // 1. Get workflow to find primary_media_id
        const { data: wf, error: wfErr } = await this.client()
            .from(this.tableName)
            .select("primary_media_id")
            .eq("id", workflow_id)
            .maybeSingle();
        
        if (wfErr) {
            console.error(`❌ [WorkflowRepo] Error fetching workflow ${workflow_id}:`, wfErr);
            return null;
        }

        if (wf?.primary_media_id) {
            const { data: media, error: mErr } = await this.client()
                .from("media")
                .select("id, url, generation_config_id")
                .eq("id", wf.primary_media_id)
                .maybeSingle();
            if (!mErr && media) return media;
        }

        // 2. Fallback: find first media created for this workflow
        const { data: firstMedia, error: fErr } = await this.client()
            .from("media")
            .select("id, url, generation_config_id")
            .eq("workflow_id", workflow_id)
            .order("create_time", { ascending: true })
            .limit(1)
            .maybeSingle();

        if (fErr) {
            console.error(`❌ [WorkflowRepo] Error fetching fallback media for wf ${workflow_id}:`, fErr);
        }

        return firstMedia || null;
    }
}
