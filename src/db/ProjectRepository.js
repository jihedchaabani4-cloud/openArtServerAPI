import { BaseRepository } from "./BaseRepository.js";

export class ProjectRepository extends BaseRepository {
    constructor() {
        super("project"); // ← singular, matches new schema
    }

    async createProject({ name }) {
        const { data, error } = await this.client()
            .from(this.tableName)
            .insert({ name })
            .select()
            .single();
        if (error) throw error;
        return data;
    }

    async findAll() {
        const { data, error } = await this.client()
            .from(this.tableName)
            .select("*")
            .order("create_time", { ascending: false });
        if (error) throw error;
        return data;
    }

    async updateName(id, name) {
        const { data, error } = await this.client()
            .from(this.tableName)
            .update({ name })
            .eq("id", id)
            .select()
            .single();
        if (error) throw error;
        return data;
    }

    /**
     * Returns all projects owned by userId with their latest media preview thumbnail.
     */
    async findProjectsWithThumbnails(userId) {
        const { data, error } = await this.client()
            .from(this.tableName)
            .select(`
                *,
                media:media(url, create_time)
            `)
            .eq("user_id", userId)
            .order("create_time", { ascending: false })
            .order("create_time", { foreignTable: "media", ascending: false })
            .limit(1, { foreignTable: "media" });
        if (error) throw error;
        return data || [];
    }

    /**
     * Inserts a new project scoped to userId.
     */
    async insertProject({ projectName, userId }) {
        const { data, error } = await this.client()
            .from(this.tableName)
            .insert([{ project_name: projectName, user_id: userId }])
            .select()
            .single();
        if (error) throw error;
        return data;
    }

    /**
     * Finds a single project by id and confirms ownership by userId.
     */
    async findOwnedProject(id, userId) {
        const query = this.client()
            .from(this.tableName)
            .select("id, user_id, project_name")
            .eq("id", id);
        const res = typeof query.maybeSingle === "function"
            ? await query.maybeSingle()
            : await query.single().catch((err) => ({ data: null, error: err }));
        const { data, error } = res || {};
        if (error || !data || data.user_id !== userId) {
            return null;
        }
        return data;
    }

    /**
     * Updates project_name scoped to owner userId.
     */
    async updateProjectName(id, userId, projectName) {
        const { data, error } = await this.client()
            .from(this.tableName)
            .update({ project_name: projectName })
            .eq("id", id)
            .eq("user_id", userId)
            .select()
            .single();
        if (error) throw error;
        return data;
    }

    /**
     * Deletes a project scoped to owner userId.
     */
    async deleteOwnedProject(id, userId) {
        const { error } = await this.client()
            .from(this.tableName)
            .delete()
            .eq("id", id)
            .eq("user_id", userId);
        if (error) throw error;
        return true;
    }

    /**
     * Returns all projects owned by userId.
     * If projectId is provided, scopes to that single project (ownership check).
     * Used by GenerationService.#getOwnedProjectIds
     */
    async findByUser(userId, projectId = null) {
        let query = this.client()
            .from(this.tableName)
            .select("id, user_id")
            .eq("user_id", userId);
        if (projectId) query = query.eq("id", projectId);
        const { data, error } = await query;
        if (error) throw error;
        return data || [];
    }

    /**
     * Returns the most recent project owned by userId, or null when none exists.
     * Used as the default target project for standalone asset uploads.
     */
    async findMostRecentForUser(userId) {
        const { data, error } = await this.client()
            .from(this.tableName)
            .select("id, user_id")
            .eq("user_id", userId)
            .order("create_time", { ascending: false })
            .limit(1)
            .maybeSingle();
        if (error) throw error;
        return data || null;
    }
}
