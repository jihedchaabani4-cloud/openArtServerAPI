import { BaseRepository } from "./BaseRepository.js";

export class ElementRepository extends BaseRepository {
    constructor() {
        super("elements");
    }

    async list({ type, search }) {
        let query = this.client().from("elements").select("*").order("created_at", { ascending: false });
        if (type) query = query.eq("type", type);
        if (search) query = query.ilike("slug", `%${search}%`);

        const { data, error } = await query;
        if (error) throw error;
        return data;
    }

    async findBySlug(slug) {
        const { data, error } = await this.client().from("elements").select("*").eq("slug", slug).single();
        if (error && error.code !== "PGRST116") throw error; // Allow null return if not found
        return data || null;
    }

    async create(payload) {
        const { data, error } = await this.client().from("elements").insert(payload).select().single();
        if (error) throw error;
        return data;
    }

    async update(id, updates) {
        const { data, error } = await this.client().from("elements").update(updates).eq("id", id).select().single();
        if (error) throw error;
        return data;
    }
}

export const elementRepository = new ElementRepository();
