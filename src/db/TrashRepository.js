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
     * Lists a user's trashed workflows ordered by deleted_at DESC.
     */
    async listByUser(userId) {
        if (!userId) return [];

        const { data, error } = await this.client()
            .from("trash")
            .select("workflow_id, deleted_at, workflow:workflow!workflow_id(display_name, workflow_type)")
            .eq("user_id", userId)
            .order("deleted_at", { ascending: false });

        if (error) throw error;

        return (data || []).map((row) => {
            const wf = Array.isArray(row.workflow) ? row.workflow[0] : row.workflow;
            return {
                workflow_id: row.workflow_id,
                display_name: wf?.display_name ?? null,
                workflow_type: wf?.workflow_type ?? null,
                deleted_at: row.deleted_at,
            };
        });
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
