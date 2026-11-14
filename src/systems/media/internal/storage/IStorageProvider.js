/**
 * IStorageProvider
 * Contract interface defining the standard methods any underlying storage engine must implement.
 * (e.g. Supabase Storage, AWS S3, Cloudflare R2, Google Cloud Storage, MinIO).
 */

export class IStorageProvider {
    /**
     * Upload a file buffer or stream to the destination path.
     * @param {string} path - Storage path/key (e.g. "userId/folder/filename.jpg")
     * @param {Buffer} buffer - File buffer
     * @param {Object} [options]
     * @param {string} [options.contentType] - MIME type
     * @param {boolean} [options.upsert] - Overwrite if exists
     * @returns {Promise<string>} Public URL of the uploaded asset
     */
    async upload(path, buffer, options = {}) {
        throw new Error("IStorageProvider.upload must be implemented by subclass");
    }

    /**
     * Get the public URL for a given path.
     * @param {string} path
     * @returns {Promise<string>}
     */
    async getPublicUrl(path) {
        throw new Error("IStorageProvider.getPublicUrl must be implemented by subclass");
    }

    /**
     * Delete a single file at the specified path.
     * @param {string} path
     * @returns {Promise<void>}
     */
    async delete(path) {
        throw new Error("IStorageProvider.delete must be implemented by subclass");
    }

    /**
     * Delete multiple files in a batch.
     * @param {string[]} paths
     * @returns {Promise<{ deletedCount: number, failures: Array<{ path: string, error: any }> }>}
     */
    async deleteFiles(paths = []) {
        throw new Error("IStorageProvider.deleteFiles must be implemented by subclass");
    }
}

export default IStorageProvider;
