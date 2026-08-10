import { BaseRepository } from "./BaseRepository.js";

export class MediaRepository extends BaseRepository {
    constructor() {
        super("media");
    }

    /**
     * Creates a media record.
     * url is stored directly (no media_versions table in new schema).
     *
     * @param {string} step_id - "CAE" for init/upload | "CAM", "CAU"... for edits
     */
    async createMedia({ workflow_id, project_id, generation_config_id, step_id, url, width, height, ...extra }) {
        const { data, error } = await this.client()
            .from(this.tableName)
            .insert({ workflow_id, project_id, generation_config_id, step_id, url, width, height, ...extra })
            .select()
            .single();
        if (error) throw error;
        return data;
    }

    async findByWorkflow(workflow_id) {
        const { data, error } = await this.client()
            .from(this.tableName)
            .select("*")
            .eq("workflow_id", workflow_id)
            .order("create_time", { ascending: true }); // init first, then edits
        if (error) throw error;
        return data;
    }

    async findLatestByWorkflow(workflow_id) {
        const { data, error } = await this.client()
            .from(this.tableName)
            .select(`
                *,
                config:generation_config (
                   dna_data:dna(name, type, description, traits)
                ),
                workflow:workflow!workflow_id (
                   workflow_type
                )
            `)
            .eq("workflow_id", workflow_id)
            .not("url", "is", null)
            .order("create_time", { ascending: false })
            .limit(1)
            .maybeSingle();

        if (error) throw error;
        return data;
    }

    async findByProject(project_id, limit = 30, offset = 0) {
        const { data, error } = await this.client()
            .from(this.tableName)
            .select("*")
            .eq("project_id", project_id)
            .order("create_time", { ascending: false })
            .range(offset, offset + limit - 1);
        if (error) throw error;
        return data;
    }

    /**
     * Finds media with its generation_config and workflow context.
     */
    async findWithContext(id) {
        const { data, error } = await this.client()
            .from(this.tableName)
            .select(`
                *,
                config:generation_config (
                    id, prompt, model, aspect_ratio, generation_type, seed,
                    dna_data:dna(name, type, description, traits)
                ),
                workflow:workflow!workflow_id (
                    id, display_name, session_id, variation_index, workflow_type
                )
            `)
            .eq("id", id)
            .single();
        if (error) throw error;
        return data;
    }

    async updateUrl(id, url) {
        const { data, error } = await this.client()
            .from(this.tableName)
            .update({ url })
            .eq("id", id)
            .select()
            .single();
        if (error) throw error;
        return data;
    }

    async updateFields(id, fields) {
        const { data, error } = await this.client()
            .from(this.tableName)
            .update(fields)
            .eq("id", id)
            .select()
            .single();
        if (error) throw error;
        return data;
    }

    async findByUrl(url) {
        const { data, error } = await this.client()
            .from(this.tableName)
            .select("*")
            .eq("url", url)
            .maybeSingle();
        if (error) throw error;
        return data;
    }

    /**
     * Deletes a media record by id AND workflow_id (scoped delete).
     * Prevents accidental deletion of media belonging to a different workflow.
     * @param {string} mediaId
     * @param {string} workflowId
     */
    async deleteByIdAndWorkflow(mediaId, workflowId) {
        const { error } = await this.client()
            .from(this.tableName)
            .delete()
            .eq("id", mediaId)
            .eq("workflow_id", workflowId);
        if (error) throw error;
    }

    /**
     * Fetches multiple media records by their IDs in one query.
     * Used by GenerationService to resolve primary media for a batch of workflows.
     */
    async findByIds(ids) {
        if (!ids || ids.length === 0) return [];
        const { data, error } = await this.client()
            .from(this.tableName)
            .select("id, workflow_id, generation_config_id, step_id, url, width, height, status, error_message, create_time")
            .in("id", ids);
        if (error) throw error;
        return data || [];
    }

    /**
     * Paginated media query scoped to a project.
     * Used by GenerationService.getAssets.
     * @param {string}  projectId
     * @param {Object}  opts
     * @param {string}  [opts.sessionId]  - optional workflow session filter
     * @param {number}  [opts.limit=30]
     * @param {number}  [opts.offset=0]
     */
    async findByProjectPaginated(projectId, { sessionId, limit = 30, offset = 0 } = {}) {
        let query = this.client()
            .from(this.tableName)
            .select("id, url, width, height, step_id, workflow_id, create_time")
            .eq("project_id", projectId)
            .order("create_time", { ascending: false })
            .range(Number(offset), Number(offset) + Number(limit) - 1);
        // Note: session_id filtering on media goes through workflow join; kept as-is per original controller behaviour
        const { data, error } = await query;
        if (error) throw error;
        return data || [];
    }
}

