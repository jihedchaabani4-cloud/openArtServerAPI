import { supabaseAdmin } from "../../../../../lib/supabase.js";
import { IStorageProvider } from "../../IStorageProvider.js";

function isStream(val) {
    return (
        val !== null &&
        typeof val === "object" &&
        (typeof val.pipe === "function" || typeof val[Symbol.asyncIterator] === "function" || typeof val.getReader === "function")
    );
}

export class SupabaseStorageProvider extends IStorageProvider {
    constructor({ bucketName = "generated_images" } = {}) {
        super();
        this.bucketName = bucketName;
    }

    async upload(path, payload, { contentType = "application/octet-stream", upsert = true, ...rest } = {}) {
        const cleanPath = path.replace(/^\/+/, "");
        const isPayloadStream = isStream(payload);
        const uploadOptions = {
            contentType,
            upsert,
            ...(isPayloadStream ? { duplex: "half" } : {}),
            ...rest,
        };

        const { error } = await supabaseAdmin.storage
            .from(this.bucketName)
            .upload(cleanPath, payload, uploadOptions);

        if (error) throw error;
        return this.getPublicUrl(cleanPath);
    }

    async getPublicUrl(path) {
        const cleanPath = path.replace(/^\/+/, "");
        const { data: { publicUrl } } = supabaseAdmin.storage
            .from(this.bucketName)
            .getPublicUrl(cleanPath);
        return publicUrl;
    }

    async delete(path) {
        const cleanPath = path.replace(/^\/+/, "");
        const { error } = await supabaseAdmin.storage
            .from(this.bucketName)
            .remove([cleanPath]);
        if (error) throw error;
    }

    /**
     * Batch delete multiple files in a single Supabase Storage API call
     */
    async deleteFiles(paths = []) {
        const uniquePaths = [...new Set((paths || []).map((p) => String(p || "").replace(/^\/+/, "")).filter(Boolean))];
        if (!uniquePaths.length) {
            return { deletedCount: 0, failures: [] };
        }

        try {
            const { data, error } = await supabaseAdmin.storage
                .from(this.bucketName)
                .remove(uniquePaths);

            if (error) {
                console.error("❌ [SupabaseStorageProvider] deleteFiles error:", error);
                return {
                    deletedCount: 0,
                    failures: uniquePaths.map((p) => ({ path: p, error: error.message })),
                };
            }

            const deletedCount = Array.isArray(data) ? data.length : uniquePaths.length;
            return { deletedCount, failures: [] };
        } catch (err) {
            console.error("❌ [SupabaseStorageProvider] deleteFiles exception:", err);
            return {
                deletedCount: 0,
                failures: uniquePaths.map((p) => ({ path: p, error: err.message })),
            };
        }
    }
}

export default SupabaseStorageProvider;
