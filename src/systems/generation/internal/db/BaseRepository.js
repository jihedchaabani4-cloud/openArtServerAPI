/**
 * System 1: Generation & Workflows — Base Repository (Internal)
 */
import { supabase } from "./generationClient.js";

export class BaseRepository {
    constructor(tableName, client = null) {
        this.tableName = tableName;
        this.dbClient = client;
    }

    client() {
        return this.dbClient || supabase;
    }

    async findById(id, select = "*") {
        const { data, error } = await this.client().from(this.tableName).select(select).eq("id", id).maybeSingle();
        if (error) throw error;
        return data;
    }

    async updateFields(id, fields) {
        const { data, error } = await this.client().from(this.tableName).update(fields).eq("id", id).select().single();
        if (error) throw error;
        return data;
    }

    async delete(id) {
        const { error } = await this.client().from(this.tableName).delete().eq("id", id);
        if (error) throw error;
    }

    async deleteById(id) {
        return this.delete(id);
    }
}
