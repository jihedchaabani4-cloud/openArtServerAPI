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
}
