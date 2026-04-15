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
            const res = await fetch(url);
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

    remove(path) {
        return this.delete(path);
    }
}

export const storageService = new StorageService();
