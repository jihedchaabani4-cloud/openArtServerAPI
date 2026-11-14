/**
 * StoragePathResolver
 * Canonical generator for storage paths across all platform domains.
 * Eliminates ad-hoc string concatenation and ensures consistent hierarchy in storage buckets.
 */
import { StorageValidationError } from "../errors.js";

export class StoragePathResolver {
    constructor({ defaultBucket = "generated_images" } = {}) {
        this.defaultBucket = defaultBucket;
    }

    _cleanId(id) {
        return String(id || "anonymous").replace(/[^a-zA-Z0-9_-]/g, "");
    }

    static ALLOWED_STORAGE_FOLDERS = new Set([
        "uploads",
        "video_uploads",
        "element-references",
        "element-sheets",
        "character-sheets",
        "character-details",
        "avatars",
        "video-references",
    ]);

    /**
     * Validates a client-facing storage folder against the explicit whitelist of known storage folders.
     *
     * @param {string} folder
     * @returns {string} The validated segment
     */
    static validateFolderSegment(folder) {
        const segment = String(folder ?? "").trim();
        if (!segment) return "uploads";
        if (!StoragePathResolver.ALLOWED_STORAGE_FOLDERS.has(segment)) {
            const preview = segment.length > 32 ? `${segment.slice(0, 32)}…` : segment;
            throw new StorageValidationError(
                `Invalid storage folder "${preview}": must be one of allowed storage folders.`
            );
        }
        return segment;
    }

    /**
     * User-uploaded project assets (images or videos)
     */
    projectAsset(userId, folder = "uploads", filename) {
        const segment = StoragePathResolver.validateFolderSegment(folder);
        return `${this._cleanId(userId)}/${segment}/${filename}`;
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
