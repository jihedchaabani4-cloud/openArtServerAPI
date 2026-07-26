/**
 * Media Storage Service
 * Smart upload adapter: accepts URL, Base64 data URI, or Buffer → uploads to Supabase Storage → returns public URL.
 * Feature: 018-element-reference-system (V1 Simplified)
 */

import { storageService } from "./StorageService.js";

/**
 * Detect the input type of a raw image source.
 * @param {string|Buffer} input
 * @returns {"url" | "base64" | "buffer"}
 */
export function detectInputType(input) {
    if (Buffer.isBuffer(input)) return "buffer";
    if (typeof input === "string") {
        if (input.startsWith("http://") || input.startsWith("https://")) return "url";
        if (input.startsWith("data:image/") || input.startsWith("data:application/")) return "base64";
        // Fallback: treat long strings without prefix as raw base64
        return "base64";
    }
    throw new Error("[mediaStorageService] Unsupported input type. Expected URL string, base64 data URI, or Buffer.");
}

/**
 * Upload a single image to Supabase Storage and return its public URL.
 * Handles URL, base64 data URI, and Buffer inputs transparently.
 *
 * @param {string|Buffer} input - The image to upload (external URL, base64 data URI, or Buffer)
 * @param {Object} options
 * @param {string} options.userId - Owning user ID (for path scoping)
 * @param {string} options.projectId - Project ID (for path scoping)
 * @param {number} [options.index=0] - Position index for filename uniqueness
 * @param {string} [options.filename] - Optional custom filename (overrides auto-generated)
 * @returns {Promise<string>} Supabase Storage public URL
 */
export async function uploadMedia(input, { userId, projectId, index = 0, filename } = {}) {
    const type = detectInputType(input);
    const ts = Date.now();
    const path = filename
        ? `${userId}/elements/${projectId}/${filename}`
        : `${userId}/elements/${projectId}/${ts}-${index}.jpg`;

    try {
        if (type === "url") {
            return await storageService.uploadFromUrl(path, input);
        } else {
            // base64 data URI or raw base64 string or Buffer
            return await storageService.upload(path, input);
        }
    } catch (err) {
        throw new Error(`[mediaStorageService] Failed to upload image at index ${index}: ${err.message}`);
    }
}

/**
 * Upload multiple images (1–6) to Supabase Storage in sequence.
 * Returns an array of public URLs in the same order as inputs.
 *
 * @param {Array<string|Buffer>} inputs - Array of image sources
 * @param {Object} options
 * @param {string} options.userId
 * @param {string} options.projectId
 * @returns {Promise<string[]>} Array of Supabase Storage public URLs
 */
export async function uploadMediaBatch(inputs, { userId, projectId }) {
    const urls = [];
    for (let i = 0; i < inputs.length; i++) {
        const url = await uploadMedia(inputs[i], { userId, projectId, index: i });
        urls.push(url);
    }
    return urls;
}

export default { detectInputType, uploadMedia, uploadMediaBatch };
