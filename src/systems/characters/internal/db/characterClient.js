/**
 * System 6: Characters — Isolated Database Client
 * Strictly isolates database client access inside internal/db/.
 */
import { supabase, supabaseAdmin } from "#shared/db/supabase.js";

export function getCharacterDbClient() {
    return supabaseAdmin;
}

export { supabase, supabaseAdmin };
