/**
 * System 6: Characters — Dedicated Database Repository (Internal)
 *
 * Interacts with the `characters` table (traits, persona, 3-view turnaround specs).
 * Isolated inside internal/db/ per Rule 6 and Rule 12.
 */
import { supabaseAdmin } from "./characterClient.js";
import { trashRepository } from "#workspace/tools";

export class CharacterRepository {
    constructor() {
        this.tableName = "characters";
    }

    /**
     * Override: use service-role client so character writes bypass RLS.
     */
    client() {
        return supabaseAdmin;
    }

    async findById(id, select = "*") {
        const { data, error } = await this.client().from(this.tableName).select(select).eq("id", id).maybeSingle();
        if (error) throw error;
        return data;
    }

    async updateFields(id, fields) {
        const { data, error } = await this.client().from(this.tableName).update(fields).eq("id", id).select().single();
        if (error) throw error;
        return data;
    }

    async delete(id) {
        const { error } = await this.client().from(this.tableName).delete().eq("id", id);
        if (error) throw error;
    }

    // ── CRUD operations ──────────────────────────────────────────────────────

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

    async findByProjectOrWorkflowIds({ projectId, workflowIds = [] } = {}) {
        let query = this.client().from("characters").select("*");
        const ids = Array.isArray(workflowIds) ? workflowIds.filter(Boolean) : [];
        if (projectId && ids.length > 0) {
            query = query.or(`project_id.eq.${projectId},workflow_id.in.(${ids.join(",")})`);
        } else if (projectId) {
            query = query.eq("project_id", projectId);
        } else if (ids.length > 0) {
            query = query.in("workflow_id", ids);
        } else {
            return [];
        }
        const { data, error } = await query;
        if (error) throw error;
        const rows = data || [];
        if (!rows.length) return [];
        const candidateWfIds = rows.flatMap((c) => [c.workflow_id, c.id]).filter(Boolean);
        const trashedSet = await trashRepository.getTrashedWorkflowIdSet({
            workflowIds: candidateWfIds,
            client: this.client(),
        });
        if (trashedSet.size === 0) return rows;
        return rows.filter(
            (c) => !(c.workflow_id && trashedSet.has(c.workflow_id)) && !(c.id && trashedSet.has(c.id))
        );
    }
}

export const characterRepository = new CharacterRepository();
export default characterRepository;
