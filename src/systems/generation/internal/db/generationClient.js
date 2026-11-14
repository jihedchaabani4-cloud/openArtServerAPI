/**
 * System 1: Generation & Workflows — Isolated Database Client
 * Strictly isolates database client access inside internal/db/.
 */
import { supabase, supabaseAdmin } from "#lib/supabase.js";

export function getGenerationDbClient() {
  return supabaseAdmin || supabase;
}

export { supabase, supabaseAdmin };
