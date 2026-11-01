import { supabase, supabaseAdmin } from "../../lib/supabase.js";

/**
 * TrashRepository — Scoped persistence for `public.trash`.
 * Every operation is scoped by `workflow_id` and/or `user_id`.
 * Intentionally does not expose unscoped `findById` or `deleteById`.
 */
export class TrashRepository {
    client() {
        return supabaseAdmin || supabase;
    }

    /**
     * Inserts a trash row if the workflow is not already in trash:
     * INSERT INTO public.trash (workflow_id, user_id, deleted_by)
     * VALUES (...) ON CONFLICT (workflow_id) DO NOTHING RETURNING *
     *
     * @returns {Promise<Object|null>} The inserted row when newly trashed, or null on conflict.
     */
    async insertIfAbsent({ workflowId, userId, deletedBy = userId }) {
        const { data, error } = await this.client()
            .from("trash")
            .upsert(
                {
                    workflow_id: workflowId,
                    user_id: userId,
                    deleted_by: deletedBy ?? userId,
                },
                { onConflict: "workflow_id", ignoreDuplicates: true }
            )
            .select();

        if (error) throw error;
        if (Array.isArray(data) && data.length > 0) {
            return data[0];
        }
        return null;
    }

    /**
     * Returns a Map of workflow_id -> { workflow_id, deleted_at, deleted_by } for candidate workflow IDs.
     */
    async getTrashedDetailsMap({ workflowIds = null, client = null } = {}) {
        const cleanIds = Array.isArray(workflowIds)
            ? [...new Set(workflowIds.filter(Boolean))]
            : null;
        if (!cleanIds || !cleanIds.length) return new Map();

        const dbClient = client || this.client();
        const { data, error } = await dbClient
            .from("trash")
            .select("workflow_id, deleted_at, deleted_by")
            .in("workflow_id", cleanIds);

        if (error) throw error;
        const map = new Map();
        for (const row of data || []) {
            if (row?.workflow_id) {
                map.set(row.workflow_id, row);
            }
        }
        return map;
    }

    /**
     * Deletes a trash row scoped to both workflow_id and user_id.
     * @returns {Promise<boolean>} true if a row was deleted, false if 0 rows matched.
     */
    async deleteByWorkflowAndUser({ workflowId, userId }) {
        if (!workflowId || !userId) return false;

        const { data, error } = await this.client()
            .from("trash")
            .delete()
            .eq("workflow_id", workflowId)
            .eq("user_id", userId)
            .select("id");

        if (error) throw error;
        return Array.isArray(data) && data.length > 0;
    }

    /**
     * Deletes trash rows scoped to user_id, optionally filtered by workflowIds.
     * @returns {Promise<Array<string>>} Array of restored workflow_ids.
     */
    async deleteManyByUser({ userId, workflowIds = null, client = null }) {
        if (!userId) return [];

        const cleanIds = Array.isArray(workflowIds)
            ? [...new Set(workflowIds.map((id) => String(id || "").replace(/^workflows\//, "").trim()).filter(Boolean))]
            : null;

        if (cleanIds && cleanIds.length === 0) return [];

        const dbClient = client || this.client();
        let query = dbClient
            .from("trash")
            .delete()
            .eq("user_id", userId);

        if (cleanIds && cleanIds.length > 0) {
            query = query.in("workflow_id", cleanIds);
        }

        const { data, error } = await query.select("workflow_id");
        if (error) throw error;
        return (data || []).map((row) => row.workflow_id).filter(Boolean);
    }

    /**
     * Returns trashed workflow_ids scoped to workflowIds and/or userId.
     */
    async listWorkflowIds({ workflowIds = null, userId = null, client = null } = {}) {
        const cleanIds = Array.isArray(workflowIds)
            ? [...new Set(workflowIds.filter(Boolean))]
            : null;
        if (cleanIds && !cleanIds.length) return [];
        if (!cleanIds && !userId) return [];

        const dbClient = client || this.client();
        let query = dbClient.from("trash").select("workflow_id");

        if (cleanIds) {
            query = query.in("workflow_id", cleanIds);
        }

        if (userId) {
            query = query.eq("user_id", userId);
        }

        const { data, error } = await query;
        if (error) throw error;
        return (data || []).map((row) => row.workflow_id).filter(Boolean);
    }

    /**
     * Returns a Set of trashed workflow_ids for fast reader exclusion.
     */
    async getTrashedWorkflowIdSet(options = {}) {
        const ids = await this.listWorkflowIds(options);
        return new Set(ids);
    }
}

export const trashRepository = new TrashRepository();
export default trashRepository;
