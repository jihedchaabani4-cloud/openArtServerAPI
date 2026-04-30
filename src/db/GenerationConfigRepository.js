import { BaseRepository } from "./BaseRepository.js";

export class GenerationConfigRepository extends BaseRepository {
    constructor() {
        super("generation_config");
    }

    /**
     * Creates a generation_config.
     * Used twice per generation:
     *   1. Once for the batch (shared config — no seed)
     *   2. Once per media (individual config — with seed + media_generation_id)
     *
     * @param {string} generation_type - "TEXT_ONLY" | "TEXT_REFERENCES" | "TEXT_BASE_IMAGE" | "TEXT_BASE_IMAGE_REFERENCES" | "UPLOAD"
     */
    async createConfig({
        prompt,
        prompt_optimise = null,
        model,
        aspect_ratio,
        generation_type,
        seed = null,
        visibility = "PRIVATE"
    }) {
        const { data, error } = await this.client()
            .from(this.tableName)
            .insert({ prompt, prompt_optimise, model, aspect_ratio, generation_type, seed, visibility })
            .select()
            .single();
        if (error) throw error;
        return data;
    }

    /**
     * Creates a reference entry linked to a generation_config.
     * position is 0-based (max 13 = 14 references).
     *
     * @param {string} input_type - "IMAGE_INPUT_TYPE_BASE_IMAGE" | "IMAGE_INPUT_TYPE_REFERENCE"
     */
    async createReference({ generation_config_id, position, input_type, ref_media_id }) {
        console.log(`🔗 [DB] Creating Reference: ConfigID=${generation_config_id}, Pos=${position}, Type=${input_type}, MediaID=${ref_media_id}`);
        const { data, error } = await this.client()
            .from("generation_config_reference")
            .insert({ generation_config_id, position, input_type, ref_media_id })
            .select()
            .single();
        if (error) throw error;
        return data;
    }

    async findReferencesByConfig(generation_config_id) {
        const { data, error } = await this.client()
            .from("generation_config_reference")
            .select("*")
            .eq("generation_config_id", generation_config_id)
            .order("position", { ascending: true });
        if (error) throw error;
        return data;
    }

    /**
     * Fetches a config with its references in one call.
     */
    async findConfigWithRefs(id) {
        const { data, error } = await this.client()
            .from(this.tableName)
            .select(`
                *,
                references:generation_config_reference (
                    id, position, input_type, ref_media_id
                )
            `)
            .eq("id", id)
            .single();
        if (error) throw error;
        return data;
    }
}
