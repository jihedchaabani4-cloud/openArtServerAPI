import { BaseRepository } from "./BaseRepository.js";

export class BatchRepository extends BaseRepository {
    constructor() {
        super("batch");
    }

    /**
     * Creates a batch record.
     * The batch owns the shared generation_config (same prompt/model/refs for all variations).
     */
    async createBatch({ project_id, session_id, generation_config_id, variation_count }) {
        const { data, error } = await this.client()
            .from(this.tableName)
            .insert({ project_id, session_id, generation_config_id, variation_count })
            .select()
            .single();
        if (error) throw error;
        return data;
    }

    async findBySession(session_id) {
        const { data, error } = await this.client()
            .from(this.tableName)
            .select("*")
            .eq("session_id", session_id)
            .order("create_time", { ascending: false });
        if (error) throw error;
        return data;
    }

    async findByProject(project_id) {
        const { data, error } = await this.client()
            .from(this.tableName)
            .select("*")
            .eq("project_id", project_id)
            .order("create_time", { ascending: false });
        if (error) throw error;
        return data;
    }
}
