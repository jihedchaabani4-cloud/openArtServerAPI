/**
 * StoragePathResolver
 * Canonical generator for storage paths across all platform domains.
 * Eliminates ad-hoc string concatenation and ensures consistent hierarchy in storage buckets.
 */
import { CrudServiceError } from "../../utils/crudOperationLog.js";

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
     * Supabase object keys are taken literally by the provider, so a folder value
     * carrying separators or traversal would become part of a foreign key path
     * with `upsert: true`. Blank values fall back to the canonical default so
     * callers without a folder override keep their existing keys.
     *
     * @param {string} folder
     * @returns {string} The validated segment
     */
    static validateFolderSegment(folder) {
        const segment = String(folder ?? "").trim();
        if (!segment) return "uploads";
        if (!StoragePathResolver.ALLOWED_STORAGE_FOLDERS.has(segment)) {
            const preview = segment.length > 32 ? `${segment.slice(0, 32)}…` : segment;
            throw new CrudServiceError(
                `Invalid storage folder "${preview}": must be one of allowed storage folders.`,
                {
                    statusCode: 400,
                    errorCode: "VALIDATION_ERROR",
                }
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
