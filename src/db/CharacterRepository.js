import { supabaseAdmin } from "../../lib/supabase.js";
import { DnaRepository } from "./DnaRepository.js";

/**
 * CharacterRepository — Dedicated Repository for Characters.
 * Interacts with the `characters` table (traits, persona, 3-view turnaround specs).
 *
 * Overrides client() to use supabaseAdmin so all operations bypass RLS.
 * This is correct for server-side service operations.
 */
export class CharacterRepository extends DnaRepository {
    /**
     * Override: use service-role client so character writes bypass RLS.
     */
    client() {
        return supabaseAdmin;
    }

    // ── Existing methods ─────────────────────────────────────────────────────

    async getCharacterByWorkflowId(workflowId) {
        return this.getByWorkflowId(workflowId);
    }

    async createCharacter({ generation_config_id, name, description = null, traits = {} }) {
        return this.createDna({
            generation_config_id,
            name,
            type: "CHARACTER",
            description,
            traits,
        });
    }

    // ── New CRUD operations ──────────────────────────────────────────────────

    /**
     * Creates or updates a character record.
     * @param {Object} payload - Fields to upsert
     * @param {string} [conflictCol="id"] - Conflict target column
     */
    async upsert(payload, conflictCol = "id") {
        const { data, error } = await this.client()
            .from("characters")
            .upsert(payload, { onConflict: conflictCol })
            .select()
            .maybeSingle();
        if (error) throw error;
        return data;
    }

    /**
     * Finds a character by id OR workflow_id.
     * @param {string} id - Character id or workflow_id
     */
    async findByCharacterId(id) {
        const { data, error } = await this.client()
            .from("characters")
            .select("*")
            .or(`id.eq.${id},workflow_id.eq.${id}`)
            .maybeSingle();
        if (error) throw error;
        return data;
    }

    /**
     * Updates character fields by id OR workflow_id.
     * @param {string} id - Character id or workflow_id
     * @param {Object} fields - Fields to patch
     */
    async updateCharacterFields(id, fields) {
        const { data, error } = await this.client()
            .from("characters")
            .update(fields)
            .or(`id.eq.${id},workflow_id.eq.${id}`)
            .select()
            .maybeSingle();
        if (error) throw error;
        return data;
    }

    async updateCharacter(id, fields) {
        return this.updateCharacterFields(id, fields);
    }

    /**
     * Deletes a character by id OR workflow_id.
     * @param {string} id - Character id or workflow_id
     */
    async deleteById(id) {
        const { error } = await this.client()
            .from("characters")
            .delete()
            .or(`id.eq.${id},workflow_id.eq.${id}`);
        if (error) throw error;
    }
}

export const characterRepository = new CharacterRepository();
export default characterRepository;
