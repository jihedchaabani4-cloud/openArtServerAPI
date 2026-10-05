/**
 * StoragePathResolver
 * Canonical generator for storage paths across all platform domains.
 * Eliminates ad-hoc string concatenation and ensures consistent hierarchy in storage buckets.
 */

export class StoragePathResolver {
    constructor({ defaultBucket = "generated_images" } = {}) {
        this.defaultBucket = defaultBucket;
    }

    _cleanExt(ext = "jpg") {
        return String(ext || "jpg").replace(/^\.+/, "").toLowerCase();
    }

    _cleanId(id) {
        return String(id || "anonymous").replace(/[^a-zA-Z0-9_-]/g, "");
    }

    /**
     * Turnaround 3-view character body sheet path
     */
    characterSheet(userId, characterId, mediaId, ext = "jpg") {
        return `character-sheets/${this._cleanId(userId)}/${characterId}/${mediaId}.${this._cleanExt(ext)}`;
    }

    /**
     * Character detail reference image path
     */
    characterDetail(userId, characterId, mediaId, ext = "jpg") {
        return `character-details/${this._cleanId(userId)}/${characterId}/${mediaId}.${this._cleanExt(ext)}`;
    }

    /**
     * Element reference image or turnaround sheet path
     */
    element(userId, projectId, filename) {
        return `elements/${this._cleanId(userId)}/${projectId}/${filename}`;
    }

    /**
     * User-uploaded project assets (images or videos)
     */
    projectAsset(userId, folder = "uploads", filename) {
        return `${this._cleanId(userId)}/${folder}/${filename}`;
    }

    /**
     * AI Generated media variation path
     */
    generation(userId, projectId, workflowId, mediaId, ext = "jpg") {
        return `generations/${this._cleanId(userId)}/${projectId}/${workflowId}/${mediaId}.${this._cleanExt(ext)}`;
    }

    /**
     * Robustly extracts relative bucket storage path from a full public CDN URL or relative path.
     * Handles:
     * - https://<host>/storage/v1/object/public/<bucket>/<path>
     * - https://<host>/<bucket>/<path>
     * - Relative paths already in storage format
     */
    extractStoragePath(url, bucketName = this.defaultBucket) {
        if (!url || typeof url !== "string") return null;

        // If it's not an HTTP URL, assume it's already a relative path
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            return url.replace(/^\/+/, "");
        }

        // Supabase standard format: .../object/public/<bucket>/<filePath>
        const objectPublicMarker = "/object/public/";
        if (url.includes(objectPublicMarker)) {
            const parts = url.split(objectPublicMarker);
            if (parts.length > 1) {
                const subParts = parts[1].split("/");
                // First part is bucket name, remaining is the path
                return subParts.slice(1).join("/");
            }
        }

        // Alternate format: .../public/<bucket>/<filePath>
        const publicMarker = "/public/";
        if (url.includes(publicMarker)) {
            const parts = url.split(publicMarker);
            if (parts.length > 1) {
                const subParts = parts[1].split("/");
                return subParts.slice(1).join("/");
            }
        }

        // Fallback: Check if URL contains the bucket name
        const bucketSegment = `/${bucketName}/`;
        if (url.includes(bucketSegment)) {
            return url.split(bucketSegment)[1] || null;
        }

        return null;
    }
}

export const storagePathResolver = new StoragePathResolver();
export default storagePathResolver;
