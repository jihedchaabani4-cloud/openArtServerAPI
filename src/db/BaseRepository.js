import { supabase } from "../../lib/supabase.js";

export class BaseRepository {
    constructor(tableName) {
        this.tableName = tableName;
    }

    client() {
        return supabase;
    }

    async findById(id, select = "*") {
        const { data, error } = await supabase.from(this.tableName).select(select).eq("id", id).single();
        if (error) throw error;
        return data;
    }

    async updateFields(id, fields) {
        const { data, error } = await supabase.from(this.tableName).update(fields).eq("id", id).select().single();
        if (error) throw error;
        return data;
    }

    async delete(id) {
        const { error } = await supabase.from(this.tableName).delete().eq("id", id);
        if (error) throw error;
    }
}
