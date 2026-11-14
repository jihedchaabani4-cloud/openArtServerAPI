/**
 * ownershipDb.js
 * Isolates direct database calls for ownership resolution inside internal/db/ per Rule 12.
 */
import { supabase } from "#shared/db/supabase.js";

export async function findCollectionItemById(id) {
  try {
    const { data, error } = await supabase
      .from("collection_items")
      .select("id, user_id, project_id, collection_id, media_id, media:media_id(id, project:project!project_id(user_id))")
      .eq("id", id)
      .maybeSingle();
    if (!error && data) return data;
  } catch {
    // Fail closed if DB call errors
  }
  return null;
}
