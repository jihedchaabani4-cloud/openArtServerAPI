import { BaseRepository } from "./BaseRepository.js";
import { createWorkflow, updateWorkflow, getWorkflows, getWorkflow } from "../../controllers/workflowsController.js";

export class WorkflowRepository extends BaseRepository {
    constructor() {
        super("workflow");
    }

    /**
     * Creates a workflow (one variation inside a batch, or a standalone upload).
     * @param {Object} data - payload
     * @param {Object} options - extra options (e.g., select)
     */
    async createWorkflow(data, options = {}) {
        return await createWorkflow(data, options);
    }

    async getWorkflow(id) {
        return await getWorkflow(id);
    }

    /**
     * Sets the primary_media_id after the first media is created.
     * Called once per workflow after generation/upload succeeds.
     */
    async updatePrimaryMedia(workflow_id, media_id) {
        await updateWorkflow(workflow_id, { primary_media_id: media_id });
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
        return await getWorkflows({ session_id }, options);
    }

    async findByProject(project_id, options = {}) {
        return await getWorkflows({ project_id }, options);
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
