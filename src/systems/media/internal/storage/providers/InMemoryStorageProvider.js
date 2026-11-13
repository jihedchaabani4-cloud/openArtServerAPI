import { IStorageProvider } from "../IStorageProvider.js";

/**
 * InMemoryStorageProvider
 * Hermetic in-memory implementation of IStorageProvider for unit and boundary testing.
 */
export class InMemoryStorageProvider extends IStorageProvider {
    constructor({
        bucketName = "generated_images",
        baseUrl = "https://storage.test/object/public",
    } = {}) {
        super();
        this.bucketName = bucketName;
        this.baseUrl = String(baseUrl).replace(/\/+$/, "");
        this.objects = new Map();
    }

    _cleanKey(path) {
        return String(path || "").replace(/^\/+/, "");
    }

    has(path) {
        return this.objects.has(this._cleanKey(path));
    }

    get(path) {
        return this.objects.get(this._cleanKey(path)) || null;
    }

    clear() {
        this.objects.clear();
    }

    async upload(path, payload, options = {}) {
        const cleanPath = this._cleanKey(path);
        this.objects.set(cleanPath, {
            key: cleanPath,
            payload,
            contentType: options.contentType || "application/octet-stream",
            options,
        });
        return this.getPublicUrl(cleanPath);
    }

    async getPublicUrl(path) {
        const cleanPath = this._cleanKey(path);
        return `${this.baseUrl}/${this.bucketName}/${cleanPath}`;
    }

    async delete(path) {
        const cleanPath = this._cleanKey(path);
        this.objects.delete(cleanPath);
    }

    async deleteFiles(paths = []) {
        const uniquePaths = [
            ...new Set((paths || []).map((p) => this._cleanKey(p)).filter(Boolean)),
        ];
        if (!uniquePaths.length) {
            return { deletedCount: 0, failures: [] };
        }
        for (const key of uniquePaths) {
            this.objects.delete(key);
        }
        return { deletedCount: uniquePaths.length, failures: [] };
    }
}

export default InMemoryStorageProvider;
