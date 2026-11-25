import { BaseRepository } from "./BaseRepository.js";

export class GenerationConfigRepository extends BaseRepository {
    constructor(client = null) {
        super("generation_config", client);
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
     * Batch-fetches multiple generation_configs with their full references (including ref_media join).
     * Used by GenerationService.#buildLibraryPayload to enrich library payloads efficiently.
     * @param {string[]} ids
     */
    async findByIdsWithReferences(ids) {
        if (!ids || ids.length === 0) return [];
        const { data, error } = await this.client()
            .from(this.tableName)
            .select(`
                id,
                prompt,
                model,
                aspect_ratio,
                generation_type,
                seed,
                visibility,
                references:generation_config_reference!generation_config_reference_generation_config_id_fkey(
                    id,
                    position,
                    input_type,
                    ref_media_id,
                    ref_media:media(
                        id,
                        url,
                        width,
                        height,
                        status,
                        create_time
                    )
                )
            `)
            .in("id", ids);
        if (error) throw error;
        return data || [];
    }
}
export const generationConfigRepository = new GenerationConfigRepository();
