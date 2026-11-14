/**
 * System 8: Workspace — Isolated Database Client
 * Strictly isolates database client access inside internal/db/.
 */
import { supabase, supabaseAdmin } from "#shared/db/supabase.js";

export function getWorkspaceDbClient() {
  return supabaseAdmin || supabase;
}

export { supabase, supabaseAdmin };
