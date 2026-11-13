/**
 * SaveTypeRegistry (Rule 11: Extensibility via Registries)
 *
 * Declarative registry defining media save types, allowed MIME types,
 * max size limits, storage bucket folders, and retention policies.
 */

const MB = 1024 * 1024;

const DEFAULT_IMAGE_MIMES = Object.freeze([
    "image/jpeg",
    "image/png",
    "image/webp",
    "image/gif",
    "image/avif",
]);

const DEFAULT_VIDEO_MIMES = Object.freeze([
    "video/mp4",
    "video/webm",
    "video/quicktime",
]);

const DEFAULT_AUDIO_MIMES = Object.freeze([
    "audio/mpeg",
    "audio/wav",
    "audio/ogg",
    "audio/mp4",
]);

export const RETENTION_POLICIES = Object.freeze({
    PERMANENT: "PERMANENT",
    TEMPORARY_30D: "TEMPORARY_30D",
    TRANSIENT_24H: "TRANSIENT_24H",
});

export const SAVE_TYPES = Object.freeze({
    DEFAULT: "default",
    ASSET_UPLOAD: "asset_upload",
    CHARACTER_SHEET: "character_sheet",
    CHARACTER_DETAIL: "character_detail",
    CHARACTER_REFERENCE: "character_reference",
    ELEMENT_REFERENCE: "element_reference",
    ELEMENT_SHEET: "element_sheet",
    WORKFLOW_OUTPUT: "workflow_output",
    WORKFLOW_INPUT: "workflow_input",
    VIDEO_OUTPUT: "video_output",
    AUDIO_OUTPUT: "audio_output",
    TEMPORARY: "temporary",
    PERMANENT: "permanent",
});

const DEFAULT_SAVE_TYPES_CONFIG = {
    [SAVE_TYPES.DEFAULT]: {
        saveType: SAVE_TYPES.DEFAULT,
        storageFolder: "uploads",
        allowedMimeTypes: [...DEFAULT_IMAGE_MIMES, ...DEFAULT_VIDEO_MIMES],
        maxSizeBytes: 100 * MB,
        retention: RETENTION_POLICIES.PERMANENT,
        isPublic: true,
    },
    [SAVE_TYPES.ASSET_UPLOAD]: {
        saveType: SAVE_TYPES.ASSET_UPLOAD,
        storageFolder: "uploads",
        allowedMimeTypes: [...DEFAULT_IMAGE_MIMES, ...DEFAULT_VIDEO_MIMES],
        maxSizeBytes: 100 * MB,
        retention: RETENTION_POLICIES.PERMANENT,
        isPublic: true,
    },
    [SAVE_TYPES.CHARACTER_SHEET]: {
        saveType: SAVE_TYPES.CHARACTER_SHEET,
        storageFolder: "character-sheets",
        allowedMimeTypes: DEFAULT_IMAGE_MIMES,
        maxSizeBytes: 20 * MB,
        retention: RETENTION_POLICIES.PERMANENT,
        isPublic: true,
    },
    [SAVE_TYPES.CHARACTER_DETAIL]: {
        saveType: SAVE_TYPES.CHARACTER_DETAIL,
        storageFolder: "character-details",
        allowedMimeTypes: DEFAULT_IMAGE_MIMES,
        maxSizeBytes: 20 * MB,
        retention: RETENTION_POLICIES.PERMANENT,
        isPublic: true,
    },
    [SAVE_TYPES.CHARACTER_REFERENCE]: {
        saveType: SAVE_TYPES.CHARACTER_REFERENCE,
        storageFolder: "uploads",
        allowedMimeTypes: DEFAULT_IMAGE_MIMES,
        maxSizeBytes: 20 * MB,
        retention: RETENTION_POLICIES.PERMANENT,
        isPublic: true,
    },
    [SAVE_TYPES.ELEMENT_REFERENCE]: {
        saveType: SAVE_TYPES.ELEMENT_REFERENCE,
        storageFolder: "element-references",
        allowedMimeTypes: DEFAULT_IMAGE_MIMES,
        maxSizeBytes: 20 * MB,
        retention: RETENTION_POLICIES.PERMANENT,
        isPublic: true,
    },
    [SAVE_TYPES.ELEMENT_SHEET]: {
        saveType: SAVE_TYPES.ELEMENT_SHEET,
        storageFolder: "element-sheets",
        allowedMimeTypes: DEFAULT_IMAGE_MIMES,
        maxSizeBytes: 20 * MB,
        retention: RETENTION_POLICIES.PERMANENT,
        isPublic: true,
    },
    [SAVE_TYPES.WORKFLOW_OUTPUT]: {
        saveType: SAVE_TYPES.WORKFLOW_OUTPUT,
        storageFolder: "uploads",
        allowedMimeTypes: [...DEFAULT_IMAGE_MIMES, ...DEFAULT_VIDEO_MIMES, ...DEFAULT_AUDIO_MIMES],
        maxSizeBytes: 100 * MB,
        retention: RETENTION_POLICIES.PERMANENT,
        isPublic: true,
    },
    [SAVE_TYPES.WORKFLOW_INPUT]: {
        saveType: SAVE_TYPES.WORKFLOW_INPUT,
        storageFolder: "uploads",
        allowedMimeTypes: [...DEFAULT_IMAGE_MIMES, ...DEFAULT_VIDEO_MIMES],
        maxSizeBytes: 50 * MB,
        retention: RETENTION_POLICIES.TEMPORARY_30D,
        isPublic: true,
    },
    [SAVE_TYPES.VIDEO_OUTPUT]: {
        saveType: SAVE_TYPES.VIDEO_OUTPUT,
        storageFolder: "video_uploads",
        allowedMimeTypes: DEFAULT_VIDEO_MIMES,
        maxSizeBytes: 150 * MB,
        retention: RETENTION_POLICIES.PERMANENT,
        isPublic: true,
    },
    [SAVE_TYPES.AUDIO_OUTPUT]: {
        saveType: SAVE_TYPES.AUDIO_OUTPUT,
        storageFolder: "uploads",
        allowedMimeTypes: DEFAULT_AUDIO_MIMES,
        maxSizeBytes: 50 * MB,
        retention: RETENTION_POLICIES.PERMANENT,
        isPublic: true,
    },
    [SAVE_TYPES.TEMPORARY]: {
        saveType: SAVE_TYPES.TEMPORARY,
        storageFolder: "uploads",
        allowedMimeTypes: [...DEFAULT_IMAGE_MIMES, ...DEFAULT_VIDEO_MIMES],
        maxSizeBytes: 50 * MB,
        retention: RETENTION_POLICIES.TRANSIENT_24H,
        isPublic: true,
    },
    [SAVE_TYPES.PERMANENT]: {
        saveType: SAVE_TYPES.PERMANENT,
        storageFolder: "uploads",
        allowedMimeTypes: [...DEFAULT_IMAGE_MIMES, ...DEFAULT_VIDEO_MIMES],
        maxSizeBytes: 100 * MB,
        retention: RETENTION_POLICIES.PERMANENT,
        isPublic: true,
    },
};

export class SaveTypeRegistry {
    constructor() {
        this._registry = new Map();
        for (const [key, cfg] of Object.entries(DEFAULT_SAVE_TYPES_CONFIG)) {
            this.register(key, cfg);
        }
    }

    register(name, config) {
        if (!name || typeof name !== "string") {
            throw new Error("[SaveTypeRegistry] SaveType name must be a non-empty string");
        }
        if (!config || !config.storageFolder) {
            throw new Error(`[SaveTypeRegistry] Configuration for save type "${name}" must define storageFolder`);
        }

        const normalizedName = name.trim().toLowerCase();
        this._registry.set(normalizedName, Object.freeze({
            saveType: normalizedName,
            storageFolder: config.storageFolder,
            allowedMimeTypes: Object.freeze([...(config.allowedMimeTypes || DEFAULT_IMAGE_MIMES)]),
            maxSizeBytes: Number(config.maxSizeBytes) || 20 * MB,
            retention: config.retention || RETENTION_POLICIES.PERMANENT,
            isPublic: config.isPublic === true,
        }));
    }

    get(name) {
        if (!name) return this._registry.get(SAVE_TYPES.DEFAULT);
        const normalized = String(name).trim().toLowerCase();
        return this._registry.get(normalized) || this._registry.get(SAVE_TYPES.DEFAULT);
    }

    has(name) {
        if (!name) return false;
        return this._registry.has(String(name).trim().toLowerCase());
    }

    validate(name, { mimeType, sizeBytes } = {}) {
        const entry = this.get(name);
        if (!entry) {
            return { valid: false, error: `Unknown save type "${name}"` };
        }
        if (mimeType && !entry.allowedMimeTypes.includes(mimeType)) {
            return {
                valid: false,
                error: `MIME type "${mimeType}" is not allowed for save type "${entry.saveType}". Allowed: ${entry.allowedMimeTypes.join(", ")}`,
            };
        }
        if (sizeBytes && sizeBytes > entry.maxSizeBytes) {
            return {
                valid: false,
                error: `File size ${sizeBytes} exceeds maximum of ${entry.maxSizeBytes} bytes for save type "${entry.saveType}"`,
            };
        }
        return { valid: true, entry };
    }

    list() {
        return Array.from(this._registry.values());
    }
}

export const saveTypeRegistry = new SaveTypeRegistry();
export default saveTypeRegistry;
