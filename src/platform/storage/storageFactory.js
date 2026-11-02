/**
 * Storage Service Factory (Rule 7)
 *
 * Encapsulates instantiation of internal SupabaseStorageProvider with an explicit
 * injected Supabase client, keeping provider classes private to the storage system.
 */
import { StorageService } from "./StorageService.js";
import { SupabaseStorageProvider } from "./providers/SupabaseStorageProvider.js";
import { StorageError } from "./StorageErrors.js";

/**
 * Factory creating a StorageService wired with the Supabase storage provider.
 *
 * @param {Object} options
 * @param {Object} options.client - Authenticated Supabase client with `.storage`
 * @param {string} [options.bucketName="generated_images"] - Storage bucket name
 * @returns {StorageService}
 */
export function createStorageService({
    client,
    bucketName = "generated_images",
} = {}) {
    if (!client || !client.storage) {
        throw new StorageError(
            "STORAGE_CONFIG_ERROR",
            "createStorageService requires an authenticated Supabase client with .storage capability."
        );
    }
    const provider = new SupabaseStorageProvider({ bucketName, client });
    return new StorageService({ bucketName, provider });
}
