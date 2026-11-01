import { supabaseAdmin } from "../../../../lib/supabase.js";
import { IStorageProvider } from "../IStorageProvider.js";
import { createLogger } from "../../../infrastructure/logging/index.js";

const storageLogger = createLogger("storage");

function isStream(val) {
    return (
        val !== null &&
        typeof val === "object" &&
        (typeof val.pipe === "function" ||
            typeof val[Symbol.asyncIterator] === "function" ||
            typeof val.getReader === "function")
    );
}

export class SupabaseStorageProvider extends IStorageProvider {
    /**
     * @param {Object} [options]
     * @param {string} [options.bucketName="generated_images"]
     * @param {Object} [options.client=supabaseAdmin] - Injected Supabase client with `.storage`.
     *   NOTE (Transitional): The `supabaseAdmin` default fallback is kept for backward compatibility
     *   with existing container/default instantiation and should be removed (making `client` required via DI)
     *   when extracting Storage into a standalone reusable package.
     */
    constructor({ bucketName = "generated_images", client = supabaseAdmin } = {}) {
        super();
        if (!client || !client.storage) {
            throw new Error("SupabaseStorageProvider requires a storage-capable client.");
        }
        this.bucketName = bucketName;
        this.client = client;
    }

    async upload(path, payload, { contentType = "application/octet-stream", upsert = true, ...rest } = {}) {
        const cleanPath = String(path || "").replace(/^\/+/, "");
        const isPayloadStream = isStream(payload);
        const uploadOptions = {
            contentType,
            upsert,
            ...(isPayloadStream ? { duplex: "half" } : {}),
            ...rest,
        };

        const { error } = await this.client.storage
            .from(this.bucketName)
            .upload(cleanPath, payload, uploadOptions);

        if (error) throw error;
        return this.getPublicUrl(cleanPath);
    }

    async getPublicUrl(path) {
        const cleanPath = String(path || "").replace(/^\/+/, "");
        const {
            data: { publicUrl },
        } = this.client.storage.from(this.bucketName).getPublicUrl(cleanPath);
        return publicUrl;
    }

    async delete(path) {
        const cleanPath = String(path || "").replace(/^\/+/, "");
        const { error } = await this.client.storage
            .from(this.bucketName)
            .remove([cleanPath]);
        if (error) throw error;
    }

    /**
     * Batch delete multiple files in a single Supabase Storage API call
     */
    async deleteFiles(paths = []) {
        const uniquePaths = [
            ...new Set(
                (paths || [])
                    .map((p) => String(p || "").replace(/^\/+/, ""))
                    .filter(Boolean)
            ),
        ];
        if (!uniquePaths.length) {
            return { deletedCount: 0, failures: [] };
        }

        try {
            const { data, error } = await this.client.storage
                .from(this.bucketName)
                .remove(uniquePaths);

            if (error) {
                storageLogger.error(
                    {
                        event: "storage.provider_batch_delete_error",
                        bucket: this.bucketName,
                        count: uniquePaths.length,
                        err: error.message || String(error),
                    },
                    "SupabaseStorageProvider batch delete error"
                );
                return {
                    deletedCount: 0,
                    failures: uniquePaths.map((p) => ({ path: p, error: error.message })),
                };
            }

            const deletedCount = Array.isArray(data) ? data.length : uniquePaths.length;
            return { deletedCount, failures: [] };
        } catch (err) {
            storageLogger.error(
                {
                    event: "storage.provider_batch_delete_exception",
                    bucket: this.bucketName,
                    count: uniquePaths.length,
                    err: err.message || String(err),
                },
                "SupabaseStorageProvider batch delete exception"
            );
            return {
                deletedCount: 0,
                failures: uniquePaths.map((p) => ({ path: p, error: err.message })),
            };
        }
    }
}

export default SupabaseStorageProvider;
