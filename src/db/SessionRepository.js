import { BaseRepository } from "./BaseRepository.js";

export class SessionRepository extends BaseRepository {
    constructor() {
        super("session"); // ← singular, matches new schema
    }

    async createSession({ project_id, name, position = 0 }) {
        const { data, error } = await this.client()
            .from(this.tableName)
            .insert({ project_id, name, position })
            .select()
            .single();
        if (error) throw error;
        return data;
    }

    async findByProject(project_id) {
        const { data, error } = await this.client()
            .from(this.tableName)
            .select("*")
            .eq("project_id", project_id)
            .order("position", { ascending: true });
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

    async updatePosition(id, position) {
        const { data, error } = await this.client()
            .from(this.tableName)
            .update({ position })
            .eq("id", id)
            .select()
            .single();
        if (error) throw error;
        return data;
    }
}
