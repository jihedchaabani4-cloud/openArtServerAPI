/**
 * System 7: Elements — Isolated Database Client
 * Strictly isolates database client access inside internal/db/.
 */
import { supabase, supabaseAdmin } from "#shared/db/supabase.js";

export function getElementDbClient() {
  return supabase;
}

export { supabase, supabaseAdmin };
