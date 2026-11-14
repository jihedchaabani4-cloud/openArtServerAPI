/**
 * System 3: Billing & Wallet — Supabase client access
 * Strictly isolated inside internal/db/ per Rule 6 & Rule 12.
 */
import { supabase, supabaseAdmin } from "#shared/db/supabase.js";

export function getBillingSupabaseClient() {
    return supabase;
}

export function getBillingSupabaseAdminClient() {
    return supabaseAdmin || supabase;
}

export { supabase, supabaseAdmin };
export default getBillingSupabaseClient;
