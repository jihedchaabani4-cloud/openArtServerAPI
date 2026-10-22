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
