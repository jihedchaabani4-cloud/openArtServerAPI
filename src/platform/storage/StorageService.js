import fetch from "node-fetch";
import { SupabaseStorageProvider } from "./storage/providers/SupabaseStorageProvider.js";

export class StorageService {
    constructor(bucketName = "generated_images", provider = null) {
        this.bucketName = bucketName;
        this.provider = provider || new SupabaseStorageProvider({ bucketName });
    }

    /**
     * @param {string} path - e.g. "userId/refs/filename.jpg"
     * @param {string|Buffer} base64OrBuffer 
     * @returns {Promise<string>} Public URL
     */
    async upload(path, base64OrBuffer) {
        let buffer;
        if (typeof base64OrBuffer === 'string') {
            const pureBase64 = base64OrBuffer.includes(",") ? base64OrBuffer.split(",")[1] : base64OrBuffer;
            buffer = Buffer.from(pureBase64, 'base64');
        } else {
            buffer = base64OrBuffer;
        }

        // Determine content type based on path extension
        let contentType = 'image/jpeg';
        if (path.endsWith('.png')) contentType = 'image/png';
        if (path.endsWith('.webp')) contentType = 'image/webp';
        if (path.endsWith('.mp4')) contentType = 'video/mp4';

        try {
            return await this.provider.upload(path, buffer, { contentType, upsert: true });
        } catch (error) {
            console.error("❌ Storage Upload Error:", error);
            throw error;
        }
    }

    /**
     * @param {string} path 
     * @param {string} url 
     * @returns {Promise<string>} Public URL
     */
    async uploadFromUrl(path, url) {
        if (!url) throw new Error("URL is required for uploadFromUrl");
        try {
            const res = await fetch(url, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                },
            });
            if (!res.ok) throw new Error(`Failed to fetch from URL: ${res.statusText}`);
            const buf = await res.arrayBuffer();
            return await this.upload(path, Buffer.from(buf));
        } catch (e) {
            console.error("❌ Storage uploadFromUrl Error:", e);
            throw e;
        }
    }

    async delete(path) {
        try {
            await this.provider.delete(path);
        } catch (error) {
            console.error("❌ Storage Delete Error:", error);
            throw error;
        }
    }

    async deleteFiles(paths = []) {
        const uniquePaths = [...new Set((paths || []).filter(Boolean))];

        if (!uniquePaths.length) {
            return { deletedCount: 0, failures: [] };
        }

        const results = await Promise.allSettled(
            uniquePaths.map((path) => this.delete(path))
        );

        const failures = results
            .map((result, index) => (result.status === "rejected"
                ? { path: uniquePaths[index], error: result.reason }
                : null))
            .filter(Boolean);

        if (failures.length) {
            console.warn("⚠️ Storage batch delete completed with failures:", failures);
        }

        return {
            deletedCount: uniquePaths.length - failures.length,
            failures,
        };
    }

    remove(path) {
        return this.delete(path);
    }
}

export const storageService = new StorageService();
