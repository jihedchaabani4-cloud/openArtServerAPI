/**
 * UploadPolicy
 * Declarative, frozen per-request upload policy presets (ADR-0012).
 *
 * NOTE: maxFilesPerRequest is a per-request HTTP/upload limit only.
 * It is strictly distinct from domain entity quotas (ELEMENT_MAX_MEDIA = 6
 * and CHARACTER_MAX_DETAIL_MEDIA = 5), even where the numbers match.
 */

const MB = 1024 * 1024;

function freezePolicy(policy) {
    if (Array.isArray(policy.allowedTypes)) {
        Object.freeze(policy.allowedTypes);
    }
    if (Array.isArray(policy.allowedMimeTypes)) {
        Object.freeze(policy.allowedMimeTypes);
    }
    if (policy.storageFolder && typeof policy.storageFolder === "object") {
        Object.freeze(policy.storageFolder);
    }
    return Object.freeze(policy);
}

export const DEFAULT_UPLOAD_POLICY = freezePolicy({
    allowedTypes: ["image", "video"],
    allowedMimeTypes: [
        "image/jpeg",
        "image/png",
        "image/webp",
        "image/gif",
        "image/avif",
        "video/mp4",
        "video/webm",
        "video/quicktime",
    ],
    maxImageSize: 20 * MB,
    maxVideoSize: 100 * MB,
    maxFilesPerRequest: 1,
    maxImagePixels: 200 * 1000 * 1000,
    maxDimensionPx: 2048,
    maxVideoDurationSec: 60,
    maxVideoPixels: 200 * 1000 * 1000,
    storageFolder: {
        image: "uploads",
        video: "video_uploads",
    },
});

export const ELEMENT_REFERENCE_UPLOAD_POLICY = freezePolicy({
    ...DEFAULT_UPLOAD_POLICY,
    allowedTypes: ["image"],
    allowedMimeTypes: ["image/jpeg", "image/png", "image/webp", "image/avif"],
    maxVideoSize: 0,
    maxFilesPerRequest: 6,
    maxImagePixels: 100 * 1000 * 1000,
    maxVideoDurationSec: 0,
    storageFolder: "element-references",
});

export const ELEMENT_SHEET_UPLOAD_POLICY = freezePolicy({
    ...ELEMENT_REFERENCE_UPLOAD_POLICY,
    maxFilesPerRequest: 1,
    storageFolder: "element-sheets",
});

export const CHARACTER_SHEET_UPLOAD_POLICY = freezePolicy({
    ...ELEMENT_REFERENCE_UPLOAD_POLICY,
    maxFilesPerRequest: 1,
    storageFolder: "character-sheets",
});

export const CHARACTER_DETAIL_UPLOAD_POLICY = freezePolicy({
    ...ELEMENT_REFERENCE_UPLOAD_POLICY,
    maxFilesPerRequest: 5,
    storageFolder: "character-details",
});

export const UPLOAD_POLICIES = Object.freeze({
    DEFAULT_UPLOAD_POLICY,
    ELEMENT_REFERENCE_UPLOAD_POLICY,
    ELEMENT_SHEET_UPLOAD_POLICY,
    CHARACTER_SHEET_UPLOAD_POLICY,
    CHARACTER_DETAIL_UPLOAD_POLICY,
});

export default UPLOAD_POLICIES;
