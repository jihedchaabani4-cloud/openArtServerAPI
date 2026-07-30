import { supabaseAdmin, supabase } from "../../../../lib/supabase.js";

export class SupabaseStorageProvider {
    constructor({ bucketName = "generated_images" } = {}) {
        this.bucketName = bucketName;
    }

    async upload(path, buffer, { contentType = "application/octet-stream", upsert = true } = {}) {
        const { error } = await supabaseAdmin.storage
            .from(this.bucketName)
            .upload(path, buffer, { contentType, upsert });

        if (error) throw error;
        return this.getPublicUrl(path);
    }

    async getPublicUrl(path) {
        const { data: { publicUrl } } = supabaseAdmin.storage
            .from(this.bucketName)
            .getPublicUrl(path);
        return publicUrl;
    }

    async delete(path) {
        const { error } = await supabaseAdmin.storage
            .from(this.bucketName)
            .remove([path]);
        if (error) throw error;
    }
}
