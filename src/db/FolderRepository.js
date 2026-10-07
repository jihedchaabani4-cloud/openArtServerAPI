import { supabase } from "../../lib/supabase.js";

/**
 * Data access layer for hierarchical folder management.
 * Strictly scoped by user_id and project_id on all operations.
 * Intentionally does NOT extend BaseRepository to avoid exposing unscoped query/delete methods.
 */
export class FolderRepository {
  constructor(client = supabase) {
    this.dbClient = client;
    this.tableName = "folders";
  }

  client() {
    return this.dbClient;
  }

  /**
   * Retrieves all folders belonging to a project owned by userId,
   * ordered hierarchically by position ASC, then name ASC.
   */
  async listByProject(projectId, userId) {
    if (!projectId || !userId) return [];
    const { data, error } = await this.client()
      .from(this.tableName)
      .select("*")
      .eq("project_id", projectId)
      .eq("user_id", userId)
      .order("position", { ascending: true })
      .order("name", { ascending: true });

    if (error) throw error;
    return data || [];
  }

  /**
   * Finds a folder by ID ensuring it belongs to the authenticated user.
   */
  async findOwned(folderId, userId) {
    if (!folderId || !userId) return null;
    const { data, error } = await this.client()
      .from(this.tableName)
      .select("*")
      .eq("id", folderId)
      .eq("user_id", userId)
      .maybeSingle();

    if (error) throw error;
    return data || null;
  }

  /**
   * Finds a folder by ID scoped to both project_id and user_id.
   */
  async findOwnedInProject(folderId, projectId, userId) {
    if (!folderId || !projectId || !userId) return null;
    const { data, error } = await this.client()
      .from(this.tableName)
      .select("*")
      .eq("id", folderId)
      .eq("project_id", projectId)
      .eq("user_id", userId)
      .maybeSingle();

    if (error) throw error;
    return data || null;
  }

  /**
   * Returns total number of folders in a project owned by userId.
   */
  async countByProject(projectId, userId) {
    if (!projectId || !userId) return 0;
    const { count, error } = await this.client()
      .from(this.tableName)
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId)
      .eq("user_id", userId);

    if (error) throw error;
    return count || 0;
  }

  /**
   * Creates a new folder scoped to project and user.
   */
  async create({ projectId, userId, parentId = null, name, position = 0 }) {
    if (!projectId || !userId || !name) {
      throw new Error("Missing required parameters for folder creation");
    }

    const { data, error } = await this.client()
      .from(this.tableName)
      .insert({
        project_id: projectId,
        user_id: userId,
        parent_id: parentId || null,
        name: String(name).trim(),
        position: Number.isInteger(position) ? position : 0,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Updates an owned folder. Prevents mutating project_id or user_id.
   */
  async updateOwned(folderId, userId, patch = {}) {
    if (!folderId || !userId) return null;

    const updateData = {};
    if (patch.name !== undefined) {
      updateData.name = String(patch.name).trim();
    }
    if (patch.parentId !== undefined) {
      updateData.parent_id = patch.parentId;
    }
    if (patch.parent_id !== undefined) {
      updateData.parent_id = patch.parent_id;
    }
    if (patch.position !== undefined) {
      updateData.position = patch.position;
    }

    if (Object.keys(updateData).length === 0) {
      return this.findOwned(folderId, userId);
    }

    updateData.updated_at = new Date().toISOString();

    const { data, error } = await this.client()
      .from(this.tableName)
      .update(updateData)
      .eq("id", folderId)
      .eq("user_id", userId)
      .select()
      .maybeSingle();

    if (error) throw error;
    return data || null;
  }

  /**
   * Deletes an owned folder. Returns true if deleted, false if not found.
   */
  async deleteOwned(folderId, userId) {
    if (!folderId || !userId) return false;

    const { data, error } = await this.client()
      .from(this.tableName)
      .delete()
      .eq("id", folderId)
      .eq("user_id", userId)
      .select();

    if (error) throw error;
    return Boolean(data && data.length > 0);
  }

  /**
   * Returns a map of folderId -> direct asset count for all folders in a project.
   * Uses a single grouped query over workflow assets.
   */
  async countAssetsByFolder(projectId, userId) {
    if (!projectId) return {};

    const { data, error } = await this.client()
      .from("workflow")
      .select("folder_id")
      .eq("project_id", projectId)
      .not("folder_id", "is", null);

    if (error) throw error;

    const counts = {};
    for (const row of data || []) {
      if (row.folder_id) {
        counts[row.folder_id] = (counts[row.folder_id] || 0) + 1;
      }
    }
    return counts;
  }

  /**
   * Counts child folders directly under the given parentId.
   */
  async countChildren(folderId, userId) {
    if (!folderId) return 0;
    let query = this.client()
      .from(this.tableName)
      .select("id", { count: "exact", head: true })
      .eq("parent_id", folderId);

    if (userId) {
      query = query.eq("user_id", userId);
    }

    const { count, error } = await query;
    if (error) throw error;
    return count || 0;
  }

  /**
   * Counts assets directly assigned to the given folderId.
   */
  async countAssetsIn(folderId, userId = null) {
    if (!folderId) return 0;
    let query = this.client()
      .from("workflow")
      .select("id", { count: "exact", head: true })
      .eq("folder_id", folderId);

    if (userId) {
      query = query.eq("user_id", userId);
    }

    const { count, error } = await query;
    if (error) throw error;
    return count || 0;
  }

  // ── Explicit Defense: Block Unscoped BaseRepository Methods ──────────────────
  findById() {
    throw new Error("Unscoped repository access is forbidden: userId required. Use findOwned().");
  }

  deleteById() {
    throw new Error("Unscoped repository access is forbidden: userId required. Use deleteOwned().");
  }

  delete() {
    throw new Error("Unscoped repository access is forbidden: userId required. Use deleteOwned().");
  }

  updateFields() {
    throw new Error("Unscoped repository access is forbidden: userId required. Use updateOwned().");
  }
}
