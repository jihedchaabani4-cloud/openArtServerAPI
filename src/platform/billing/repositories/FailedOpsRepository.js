/**
 * @owns Persistence operations for public.failed_wallet_operations table.
 */
export class FailedOpsRepository {
    /**
     * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
     */
    constructor(supabaseClient) {
        if (!supabaseClient) {
            throw new Error("[FailedOpsRepository] supabaseClient is required");
        }
        this.supabase = supabaseClient;
    }

    /**
     * Finds an existing failed operation by reference_id and operation_type.
     */
    async findExisting(referenceId, operationType) {
        const { data } = await this.supabase
            .from("failed_wallet_operations")
            .select("id")
            .eq("reference_id", referenceId)
            .eq("operation_type", operationType)
            .maybeSingle();

        return data;
    }

    /**
     * Inserts a new failed operation record.
     */
    async insertFailedOp(record) {
        const { error } = await this.supabase
            .from("failed_wallet_operations")
            .insert(record);

        return { error };
    }

    /**
     * Fetches pending failed operations ready for retry.
     */
    async getPendingOps(limit = 50) {
        const now = new Date().toISOString();

        const { data, error } = await this.supabase
            .from("failed_wallet_operations")
            .select("*")
            .eq("status", "PENDING")
            .or(`next_retry_at.is.null,next_retry_at.lte.${now}`)
            .order("created_at", { ascending: true })
            .limit(limit);

        if (error) throw new Error(`[FailedOpsRepository] getPendingOps failed: ${error.message}`);
        return data || [];
    }

    /**
     * Marks a failed operation as COMPLETED.
     */
    async markCompleted(id) {
        const { error } = await this.supabase
            .from("failed_wallet_operations")
            .update({ status: "COMPLETED" })
            .eq("id", id);

        if (error) throw new Error(`[FailedOpsRepository] markCompleted(${id}) failed: ${error.message}`);
    }

    /**
     * Updates retry count and next_retry_at timestamp.
     */
    async markRetryScheduled(id, retryCount, nextRetryAt) {
        const { error } = await this.supabase
            .from("failed_wallet_operations")
            .update({
                retry_count: retryCount,
                next_retry_at: nextRetryAt,
            })
            .eq("id", id);

        if (error) throw new Error(`[FailedOpsRepository] markRetryScheduled(${id}) failed: ${error.message}`);
    }

    /**
     * Marks a failed operation as ABANDONED with a failure reason.
     */
    async markAbandoned(id, reason) {
        const { error } = await this.supabase
            .from("failed_wallet_operations")
            .update({ status: "ABANDONED", failure_reason: reason })
            .eq("id", id);

        if (error) throw new Error(`[FailedOpsRepository] markAbandoned(${id}) failed: ${error.message}`);
    }
}
