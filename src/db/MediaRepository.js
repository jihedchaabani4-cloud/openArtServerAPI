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
                    id, prompt, model, aspect_ratio, generation_type, seed
                ),
                workflow:workflow!workflow_id (
                    id, display_name, session_id, variation_index
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
}
