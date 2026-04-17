import { BaseRepository } from "./BaseRepository.js";

/**
 * DnaRepository — CRUD for the `dna` table.
 *
 * Table schema:
 *   id                  uuid PK
 *   generation_config_id uuid FK → generation_config(id)
 *   name                text
 *   type                text   (e.g. "CHARACTER")
 *   description         text   (LLM-generated narrative)
 *   traits              jsonb  (raw features from the frontend)
 *   create_time         timestamptz
 */
export class DnaRepository extends BaseRepository {
    constructor() {
        super("dna");
    }

    /**
     * Creates a new DNA record.
     *
     * @param {{ generation_config_id, name, type, description, traits }} payload
     */
    async createDna({ generation_config_id, name, type, description = null, traits = {} }) {
        const { data, error } = await this.client()
            .from(this.tableName)
            .insert({ generation_config_id, name, type, description, traits })
            .select()
            .single();
        if (error) throw error;
        return data;
    }

    /**
     * Finds all DNA records linked to a given generation_config_id.
     */
    async findByConfig(generation_config_id) {
        const { data, error } = await this.client()
            .from(this.tableName)
            .select("*")
            .eq("generation_config_id", generation_config_id)
            .order("create_time", { ascending: true });
        if (error) throw error;
        return data;
    }

    /**
     * Updates the description of an existing DNA record.
     */
    async updateDescription(id, description) {
        const { data, error } = await this.client()
            .from(this.tableName)
            .update({ description })
            .eq("id", id)
            .select()
            .single();
        if (error) throw error;
        return data;
    }
}
