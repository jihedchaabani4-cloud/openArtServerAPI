/**
 * ProfileRepository
 * Owns exclusive DB access for the `profiles` table per Rule 5 & Rule 12.
 */
import { supabase } from "#lib/supabase.js";

export const ProfileRepository = {
  /**
   * Upsert a user profile record to avoid race conditions on first login.
   *
   * @param {string} userId
   * @param {Object} [extra]
   * @returns {Promise<Object|null>}
   */
  async upsertProfile(userId, extra = {}) {
    const { data, error } = await supabase
      .from("profiles")
      .upsert({ id: userId, ...extra }, { onConflict: ["id"] });

    if (error) throw error;
    return data?.[0] ?? null;
  },

  /**
   * Find a user profile by ID.
   *
   * @param {string} userId
   * @returns {Promise<Object|null>}
   */
  async findById(userId) {
    const { data, error } = await supabase
      .from("profiles")
      .select("id, email, display_name, avatar_url, created_at, updated_at")
      .eq("id", userId)
      .maybeSingle();

    if (error) throw error;
    return data || null;
  },
};

export default ProfileRepository;
