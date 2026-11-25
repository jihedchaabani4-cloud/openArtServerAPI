/**
 * System 4: Media & Storage — Public Tools Gateway (Rule 1, Rule 8)
 *
 * @description Exposes clean DTO operations for media creation, external media persistence,
 * linking, URL resolution, asset upload, and storage management.
 */

import { createLogger, envConfig } from "#shared";
import { saveTypeRegistry, SAVE_TYPES, RETENTION_POLICIES } from "../internal/services/saveTypes.js";
import { MediaRepository } from "../internal/db/MediaRepository.js";
import { WorkflowMediaRepository } from "../internal/db/WorkflowMediaRepository.js";
import {
    createMediaInWorkflow,
    linkWorkflowMediaForCreatedRow,
} from "../internal/db/workflowMediaLinker.js";
import {
    markMediaStatus,
    markMediaFailed as internalMarkMediaFailed,
    createWorkflowWithMedia,
    createWorkflowWithMediaAtomic,
    createGenerationPlaceholderAtomic,
    appendMediaToWorkflow,
} from "../internal/db/workflowMediaOps.js";
import {
    WORKFLOW_MEDIA_ROLES,
    normalizeWorkflowMediaRole,
    inferWorkflowMediaRole,
} from "../internal/db/workflowMediaRole.js";
import {
    getMediaSupabaseClient,
    getMediaSupabaseAdminClient,
} from "../internal/db/mediaClient.js";
import { StorageService } from "../internal/storage/StorageService.js";
import { StoragePathResolver, storagePathResolver } from "../internal/storage/StoragePathResolver.js";
import {
    createStorageService,
    IStorageProvider,
    InMemoryStorageProvider,
    SupabaseStorageProvider,
} from "../internal/storage/storageFactory.js";
import { isStream } from "../internal/storage/streamUtils.js";
import { MediaUploadService } from "../internal/services/MediaUploadService.js";
import { AssetUploadService } from "../internal/services/AssetUploadService.js";
import { MediaInspector } from "../internal/ingestion/MediaInspector.js";
import {
    extractImageMetadata,
    extractVideoMetadata,
    extractMediaMetadata,
} from "../internal/ingestion/MediaMetadataExtractor.js";
import { SourceResolver } from "../internal/ingestion/SourceResolver.js";
import { SourceReader } from "../internal/ingestion/SourceReader.js";
import { SourcePolicy } from "../internal/ingestion/SourcePolicy.js";
import {
    createSizeLimitedMemoryStorage,
    resetActiveUploadsForTest,
    resetInFlightBytesForTest,
    getActiveUploadsCountForTest,
    getInFlightBytesForTest,
} from "../internal/ingestion/sizeLimitedStorage.js";
import {
    DEFAULT_UPLOAD_POLICY,
    ELEMENT_REFERENCE_UPLOAD_POLICY,
    ELEMENT_SHEET_UPLOAD_POLICY,
    ELEMENT_SOURCES_UPLOAD_POLICY,
    CHARACTER_SHEET_UPLOAD_POLICY,
    CHARACTER_DETAIL_UPLOAD_POLICY,
    UPLOAD_POLICIES,
} from "../internal/ingestion/UploadPolicy.js";
import { MediaService } from "../internal/services/MediaService.js";
import {
    MediaWorkflowLifecycleService,
    MEDIA_WORKFLOW_STATUS,
    MEDIA_IN_FLIGHT_STATUSES,
    isMediaInFlight,
    isMediaFailed,
    hasInFlightMedia,
    areAllWorkflowMediaFailed,
    failWorkflowPendingMedia,
    normalizeNodeMediaOutputs,
} from "../internal/services/MediaLifecycleService.js";
import { V1StorageBridge } from "../internal/services/v1StorageBridge.js";
import {
    resolveMediaMetadata,
    calculateAspectRatio,
} from "../internal/services/mediaMetadataResolver.js";
import {
    setMediaServices,
    getMediaRepository as getAccessorMediaRepository,
} from "../internal/services/serviceAccessor.js";
import {
    MediaError,
    MediaValidationError,
    MediaNotFoundError,
    MediaConflictError,
    MediaStorageError,
    MediaUploadError,
    MediaQuotaError,
    StorageError,
    StorageValidationError,
    ValidationError,
    UploadError,
    QuotaError,
    WORKFLOW_REFERENCE_QUOTA_PREFIX,
    WORKFLOW_REFERENCE_QUOTA_PATTERN,
    formatWorkflowReferenceQuotaMessage,
    isWorkflowReferenceQuotaError,
    createPayloadTooLargeError,
} from "../internal/errors.js";

const mediaToolsLogger = createLogger("media-tools");

// Singletons managed by the media system
let _workflowMediaRepo = null;
let _storageService = null;
let _mediaUploadService = null;
let _mediaService = null;
let _assetUploadService = null;

export function configureMedia(services = {}) {
    if (services.assetUploadService) _assetUploadService = services.assetUploadService;
    if (services.storageService) _storageService = services.storageService;
    if (services.mediaUploadService) _mediaUploadService = services.mediaUploadService;
    if (services.mediaService) _mediaService = services.mediaService;
    if (services.workflowMediaRepository) _workflowMediaRepo = services.workflowMediaRepository;
    else if (services.db?.workflowMedia) _workflowMediaRepo = services.db.workflowMedia;
    setMediaServices(services);
}

export function getMediaRepository() {
    return getAccessorMediaRepository();
}

export function getWorkflowMediaRepository() {
    if (!_workflowMediaRepo) {
        _workflowMediaRepo = new WorkflowMediaRepository();
    }
    return _workflowMediaRepo;
}

export function getStorageService() {
    if (!_storageService) {
        const client = getMediaSupabaseAdminClient();
        _storageService = createStorageService({ client });
    }
    return _storageService;
}

export function setStorageService(customStorageService) {
    _storageService = customStorageService;
}

export function getMediaUploadService() {
    if (!_mediaUploadService) {
        _mediaUploadService = new MediaUploadService({ storageService: getStorageService() });
    }
    return _mediaUploadService;
}

export function getMediaService() {
    if (!_mediaService) {
        _mediaService = new MediaService({ mediaRepo: getMediaRepository() });
    }
    return _mediaService;
}

export function getSaveTypeRegistry() {
    return saveTypeRegistry;
}

// ── Pure DTO Tool Functions (Rule 8) ──────────────────────────────────────────

/**
 * Creates a pending placeholder media record in `public.media` and links it to a workflow.
 *
 * @param {Object} params
 * @param {string} params.userId
 * @param {string} [params.workflowId]
 * @param {string} [params.saveType="default"]
 * @param {string} [params.role="output"]
 * @param {string} [params.stepId="upload"]
 * @param {number} [params.width=1024]
 * @param {number} [params.height=1024]
 * @param {string} [params.projectId]
 * @returns {Promise<{ mediaId: string, status: string, stepId: string, width: number, height: number }>}
 */
export async function createPendingMedia({
    userId,
    workflowId = null,
    saveType = "default",
    role = "output",
    stepId = "upload",
    width = 1024,
    height = 1024,
    projectId = null,
} = {}) {
    if (!userId) {
        throw new MediaValidationError("userId is required to create pending media");
    }

    const repo = getMediaRepository();
    const media = await repo.createMedia({
        project_id: projectId,
        step_id: stepId,
        url: null,
        width,
        height,
        status: "processing",
    });

    if (workflowId && media?.id) {
        const wfMediaRepo = getWorkflowMediaRepository();
        await wfMediaRepo.linkMedia({
            workflowId,
            mediaId: media.id,
            role,
            stepId,
        });
    }

    return {
        mediaId: media.id,
        status: media.status || "processing",
        stepId: media.step_id || stepId,
        width: media.width || width,
        height: media.height || height,
        projectId: media.project_id || projectId,
    };
}

function isAlreadyInOwnStorage(source) {
    if (typeof source !== "string") return false;
    const base = (envConfig.rawSupabaseUrl || "").trim().replace(/\/+$/, "");
    if (!base) return false;
    return source.trim().startsWith(`${base}/storage/v1/object/`);
}

function assertPlaceholderCompletable(existingMedia, mediaId) {
    if (!existingMedia) return;
    const status = existingMedia.status;
    const isTerminalOrInactive =
        status === MEDIA_WORKFLOW_STATUS.FAILED ||
        existingMedia.hold_expired === true ||
        (typeof status === "string" &&
            status !== MEDIA_WORKFLOW_STATUS.PROCESSING &&
            status !== "pending");

    if (isTerminalOrInactive) {
        throw new MediaConflictError(
            `Cannot complete media "${mediaId}" because its placeholder is no longer in-flight (status: "${status || "unknown"}", hold_expired: ${Boolean(existingMedia.hold_expired)})`,
            {
                code: "HOLD_EXPIRED",
                statusCode: 409,
                context: { mediaId, status },
            }
        );
    }
}

/**
 * Persists external media (e.g., from provider temp URL or raw buffer) to Supabase Storage
 * (idempotently skipping upload when already stored in our own bucket), extracts real width/height,
 * commits via unified `completeMedia()` (preserving generation_config, is_primary, and in-flight DB guard),
 * and immediately discards the uploaded storage object if DB commit fails.
 *
 * @param {Object} params
 * @param {string} params.mediaId
 * @param {string|Buffer} params.source
 * @param {string} params.userId
 * @param {string} [params.saveType="default"]
 * @param {string} [params.role="output"]
 * @param {string|null} [params.finalPrompt=null]
 * @param {string|null} [params.characterDescription=null]
 * @param {Object} [params.metadata={}]
 * @param {string|null} [params.workflowId=null]
 * @param {string|null} [params.stepId=null]
 * @param {Object|null} [params.mediaRepository=null]
 * @param {Object|null} [params.workflowMediaRepository=null]
 * @param {Object|null} [params.uploadService=null]
 * @returns {Promise<Object>} Plain completed media DTO
 */
export async function persistExternalMedia({
    mediaId,
    source,
    userId,
    saveType = "default",
    role = "output",
    finalPrompt = null,
    characterDescription = null,
    metadata = {},
    workflowId = null,
    stepId = null,
    mediaRepository = null,
    workflowMediaRepository = null,
    uploadService = null,
} = {}) {
    if (!mediaId) throw new MediaValidationError("mediaId is required for persistExternalMedia");
    if (!source) throw new MediaValidationError("source is required for persistExternalMedia");
    if (!userId) throw new MediaValidationError("userId is required for persistExternalMedia");

    const repo = mediaRepository || getMediaRepository();
    if (typeof repo?.findById === "function") {
        const existingMedia = await repo.findById(mediaId).catch(() => null);
        assertPlaceholderCompletable(existingMedia, mediaId);
    }

    const baseMeta = metadata && typeof metadata === "object" ? { ...metadata } : {};
    const effectiveFinalPrompt = finalPrompt ?? baseMeta.prompt ?? null;
    const effectiveCharDesc = characterDescription ?? baseMeta.character_description ?? null;
    const effectiveRole = role || baseMeta.role || "output";

    let finalUrl = typeof source === "string" ? source.trim() : null;
    let uploadedStorageKey = null;
    let realWidth = baseMeta.width || null;
    let realHeight = baseMeta.height || null;
    let realRatio = baseMeta.ratio || null;
    const uploader = uploadService || getMediaUploadService();

    if (!isAlreadyInOwnStorage(source)) {
        const stConfig = saveTypeRegistry.get(saveType);
        const folder = stConfig?.storageFolder || "uploads";

        const uploadResult = await uploader.upload({
            files: [source],
            policy: DEFAULT_UPLOAD_POLICY,
            userId,
            folder,
        });

        const uploadedList = Array.isArray(uploadResult) ? uploadResult : uploadResult?.uploaded;
        const uploaded = Array.isArray(uploadedList) ? uploadedList[0] : null;
        if (!uploaded || !uploaded.url) {
            throw new MediaStorageError("Failed to persist media to cloud storage");
        }

        finalUrl = uploaded.url;
        uploadedStorageKey = uploaded.storageKey || uploaded.key || null;
        if (uploaded.width) realWidth = uploaded.width;
        if (uploaded.height) realHeight = uploaded.height;
        if (uploaded.ratio) realRatio = uploaded.ratio;
    }

    const mergedMeta = {
        ...baseMeta,
        ...(realWidth ? { width: realWidth } : {}),
        ...(realHeight ? { height: realHeight } : {}),
        ...(uploadedStorageKey ? { storageKey: uploadedStorageKey } : {}),
    };

    try {
        const completed = await completeMedia({
            mediaId,
            url: finalUrl,
            finalPrompt: effectiveFinalPrompt,
            characterDescription: effectiveCharDesc,
            metadata: mergedMeta,
            role: effectiveRole,
            saveType,
            workflowId,
            stepId,
            mediaRepository: repo,
            workflowMediaRepository,
        });

        const finalWidth = completed.width || realWidth || null;
        const finalHeight = completed.height || realHeight || null;
        return {
            ...completed,
            ...(finalWidth ? { width: finalWidth } : {}),
            ...(finalHeight ? { height: finalHeight } : {}),
            ratio:
                realRatio ||
                (finalWidth && finalHeight ? calculateAspectRatio(finalWidth, finalHeight) : null),
        };
    } catch (commitErr) {
        if (uploadedStorageKey && typeof uploader?.discard === "function") {
            await uploader.discard([uploadedStorageKey]).catch((discardErr) => {
                mediaToolsLogger.error(
                    {
                        event: "media.persist_external.discard_failed",
                        mediaId,
                        storageKey: uploadedStorageKey,
                        err: discardErr?.message,
                    },
                    "[MediaTools] Compensating storage discard failed after DB commit error"
                );
            });
        }
        throw commitErr;
    }
}

/**
 * Completes a pending placeholder media record with its final asset URL and metadata,
 * enforces fail-closed protection against terminal failed/expired placeholders, and
 * ensures the canonical workflow_media role link exists.
 *
 * @param {Object} params
 * @param {string} params.mediaId
 * @param {string} params.url
 * @param {string|null} [params.finalPrompt=null]
 * @param {string|null} [params.characterDescription=null]
 * @param {Object} [params.metadata={}]
 * @param {string} [params.role="output"]
 * @param {string} [params.saveType="default"]
 * @param {string|null} [params.workflowId=null]
 * @param {string|null} [params.stepId=null]
 * @param {Object|null} [params.mediaRepository=null]
 * @param {Object|null} [params.workflowMediaRepository=null]
 * @returns {Promise<Object>} Plain completed media DTO
 */
export async function completeMedia({
    mediaId,
    url,
    finalPrompt = null,
    characterDescription = null,
    metadata = {},
    role = "output",
    saveType = "default",
    workflowId = null,
    stepId = null,
    mediaRepository = null,
    workflowMediaRepository = null,
} = {}) {
    if (!mediaId) throw new MediaValidationError("mediaId is required for completeMedia");
    if (!url) throw new MediaValidationError("url is required for completeMedia");

    const repo = mediaRepository || getMediaRepository();
    const updateFn =
        typeof repo?.updateMedia === "function"
            ? repo.updateMedia.bind(repo)
            : typeof repo?.updateFields === "function"
                ? repo.updateFields.bind(repo)
                : null;

    if (!updateFn) {
        throw new MediaValidationError("MediaRepository is not configured in #media/tools for completeMedia");
    }

    let existingMedia = null;
    if (typeof repo?.findById === "function") {
        existingMedia = await repo.findById(mediaId).catch(() => null);
    }

    assertPlaceholderCompletable(existingMedia, mediaId);

    const meta = metadata && typeof metadata === "object" ? metadata : {};
    let mergedConfig;
    if (existingMedia?.generation_config && typeof existingMedia.generation_config === "object") {
        const baseConfig = { ...existingMedia.generation_config };
        if (finalPrompt && baseConfig.prompt && finalPrompt !== baseConfig.prompt) {
            baseConfig.prompt_optimized = finalPrompt;
        } else {
            delete baseConfig.prompt_optimized;
        }
        if (characterDescription) {
            baseConfig.character_description = characterDescription;
        }
        if (meta.provider) {
            baseConfig.provider = meta.provider;
        }
        if (meta.model && !baseConfig.model) {
            baseConfig.model = meta.model;
        }
        mergedConfig = baseConfig;
    } else if (characterDescription || meta.provider || meta.model) {
        mergedConfig = {
            ...(finalPrompt ? { prompt_optimized: finalPrompt } : {}),
            ...(characterDescription ? { character_description: characterDescription } : {}),
            ...(meta.provider ? { provider: meta.provider } : {}),
            ...(meta.model ? { model: meta.model } : {}),
        };
    }

    const updated = await updateFn(mediaId, {
        url,
        status: MEDIA_WORKFLOW_STATUS.SUCCESS,
        error_message: null,
        ...(meta.width || existingMedia?.width ? { width: meta.width || existingMedia.width } : {}),
        ...(meta.height || existingMedia?.height ? { height: meta.height || existingMedia.height } : {}),
        ...(mergedConfig && Object.keys(mergedConfig).length > 0 ? { generation_config: mergedConfig } : {}),
    });

    const parentWorkflowId = workflowId || existingMedia?.workflow_id || null;
    if (parentWorkflowId && role) {
        const wfRepo = workflowMediaRepository || getWorkflowMediaRepository();
        if (wfRepo && typeof wfRepo.linkMedia === "function") {
            try {
                const alreadyLinked =
                    typeof wfRepo.isMediaLinkedToWorkflow === "function"
                        ? await wfRepo.isMediaLinkedToWorkflow({
                              workflowId: parentWorkflowId,
                              mediaId,
                          })
                        : false;

                if (!alreadyLinked) {
                    await wfRepo.linkMedia({
                        workflowId: parentWorkflowId,
                        mediaId,
                        role,
                        stepId: stepId || parentWorkflowId || "save_media",
                    });
                }
            } catch (linkErr) {
                mediaToolsLogger.warn(
                    {
                        event: "media.complete_media.link_failed",
                        mediaId,
                        workflowId: parentWorkflowId,
                        role,
                        err: linkErr?.message,
                    },
                    "[MediaTools] Non-fatal workflow_media link failure after completing media"
                );
            }
        }
    }

    return {
        mediaId: updated?.id || mediaId,
        id: updated?.id || mediaId,
        url: updated?.url || url,
        ...(updated?.width || meta.width || existingMedia?.width
            ? { width: updated?.width || meta.width || existingMedia?.width }
            : {}),
        ...(updated?.height || meta.height || existingMedia?.height
            ? { height: updated?.height || meta.height || existingMedia?.height }
            : {}),
        prompt: finalPrompt || null,
        role,
        save_type: saveType,
        ...(characterDescription ? { character_description: characterDescription } : {}),
        status: updated?.status || MEDIA_WORKFLOW_STATUS.SUCCESS,
        metadata: meta,
    };
}

/**
 * Marks a media record as failed.
 *
 * @param {Object} params
 * @param {string} params.mediaId
 * @param {string} [params.errorCode="MEDIA_FAILED"]
 * @param {string} [params.errorMessage]
 * @returns {Promise<{ mediaId: string, status: string, errorCode: string }>}
 */
export async function markMediaFailed(firstArg = {}, secondArg, thirdArg) {
    if (secondArg !== undefined || thirdArg !== undefined) {
        return internalMarkMediaFailed(firstArg, secondArg, thirdArg);
    }

    const {
        mediaId,
        errorCode = "MEDIA_FAILED",
        errorMessage = null,
    } = firstArg || {};
    if (!mediaId) throw new MediaValidationError("mediaId is required for markMediaFailed");

    const repo = getMediaRepository();
    await repo.updateFields(mediaId, {
        status: "failed",
        error_message: errorMessage || errorCode,
    });

    return {
        mediaId,
        status: "failed",
        errorCode,
        errorMessage: errorMessage || errorCode,
    };
}

/**
 * Links a media item to a workflow or entity in `workflow_media`.
 *
 * @param {Object} params
 * @param {string} params.mediaId
 * @param {string} params.workflowId
 * @param {string} [params.role="output"]
 * @param {string|null} [params.stepId=null]
 * @param {boolean} [params.isPrimary=false]
 * @param {Object} [params.metadata]
 * @returns {Promise<Object>} Plain link record
 */
export async function linkMediaToEntity({
    mediaId,
    workflowId,
    role = "output",
    stepId = null,
    isPrimary = false,
    metadata = {},
} = {}) {
    if (!mediaId || !workflowId) {
        throw new MediaValidationError("mediaId and workflowId are required for linkMediaToEntity");
    }

    const wfRepo = getWorkflowMediaRepository();
    const result = await wfRepo.linkMedia({
        workflowId,
        mediaId,
        role,
        ...(stepId ? { stepId } : {}),
        is_primary: isPrimary,
        metadata,
    });

    return {
        workflowId: result?.workflow_id || workflowId,
        mediaId: result?.media_id || mediaId,
        role: result?.role || role,
        isPrimary: Boolean(result?.is_primary),
    };
}

/**
 * Retrieves public URLs and status for a list of media IDs.
 *
 * @param {string[]} mediaIds
 * @returns {Promise<Array<{ mediaId: string, url: string|null, status: string, width: number, height: number }>>}
 */
export async function getMediaUrls(mediaIds = []) {
    if (!Array.isArray(mediaIds) || mediaIds.length === 0) return [];

    const repo = getMediaRepository();
    const rows = await repo.findByIds(mediaIds);

    return rows.map((r) => ({
        mediaId: r.id,
        url: r.url || null,
        status: r.status || "unknown",
        width: r.width,
        height: r.height,
    }));
}

/**
 * Resolves a single media record by ID.
 *
 * @param {string} mediaId
 * @returns {Promise<Object|null>} Plain DTO or null
 */
export async function getMediaById(mediaId) {
    if (!mediaId) return null;
    const repo = getMediaRepository();
    const record = await repo.findById(mediaId);
    if (!record) return null;

    return {
        id: record.id,
        url: record.url,
        width: record.width,
        height: record.height,
        status: record.status,
        stepId: record.step_id,
        projectId: record.project_id,
        createTime: record.create_time,
        errorMessage: record.error_message,
    };
}

function isValidHttpUrl(value) {
    if (typeof value !== "string") return false;
    const trimmed = value.trim();
    return trimmed.startsWith("http://") || trimmed.startsWith("https://");
}

function isCompletedHttpMedia(item) {
    return Boolean(
        item &&
        item.status === MEDIA_WORKFLOW_STATUS.SUCCESS &&
        isValidHttpUrl(item.url)
    );
}

async function loadHydratedWorkflowMedia(workflowId, { workflowMediaRepository = null, mediaRepository = null } = {}) {
    if (!workflowId) return [];

    const wfRepo = workflowMediaRepository || getWorkflowMediaRepository();
    if (!wfRepo || typeof wfRepo.findByWorkflow !== "function") return [];

    let rawRows = [];
    try {
        rawRows = (await wfRepo.findByWorkflow(workflowId)) || [];
    } catch (err) {
        mediaToolsLogger.debug(
            { workflowId, err: err?.message },
            "[MediaTools] Unable to read workflow_media rows for visual lookup"
        );
        return [];
    }

    if (!Array.isArray(rawRows) || rawRows.length === 0) return [];

    let repo = mediaRepository;
    const getMediaRepoSafe = () => {
        if (repo) return repo;
        try {
            repo = getMediaRepository();
        } catch {
            repo = null;
        }
        return repo;
    };

    const hydrated = [];
    for (const item of rawRows) {
        if (!item) continue;
        if (item.status !== undefined || item.url !== undefined) {
            hydrated.push(item);
            continue;
        }
        const itemId = item.id || item.media_id;
        const activeMediaRepo = getMediaRepoSafe();
        if (itemId && typeof activeMediaRepo?.findById === "function") {
            const full = await activeMediaRepo.findById(itemId).catch(() => null);
            if (full) {
                hydrated.push({ ...item, ...full, id: full.id || itemId });
                continue;
            }
        }
        hydrated.push(item);
    }

    return hydrated;
}

function toWorkflowVisualDto(item) {
    const mediaId = item.id || item.media_id || null;
    return {
        mediaId,
        id: mediaId,
        url: item.url.trim(),
        role: item.role || item.mediaRole || null,
        isPrimary: Boolean(item.is_primary || item.isPrimary),
        status: item.status,
        width: item.width ?? null,
        height: item.height ?? null,
    };
}

/**
 * Resolves completed (`status === 'success'`), valid HTTP(S) visual media linked to a workflow
 * via `workflow_media`, prioritizing `is_primary = true` first and then `preferredRoles` order.
 *
 * @param {string} workflowId
 * @param {Object} [options]
 * @param {string[]} [options.preferredRoles] - Ordered role priority (e.g. ["sheet", "detail", "reference"])
 * @param {string[]} [options.excludeRoles] - Roles to exclude
 * @param {Object|null} [options.workflowMediaRepository]
 * @param {Object|null} [options.mediaRepository]
 * @returns {Promise<Array<{ mediaId: string|null, id: string|null, url: string, role: string|null, isPrimary: boolean, status: string, width: number|null, height: number|null }>>}
 */
export async function getWorkflowVisualMedia(
    workflowId,
    {
        preferredRoles = ["sheet", "turnaround", "avatar", "detail", "reference", "output", "original"],
        excludeRoles = [],
        workflowMediaRepository = null,
        mediaRepository = null,
    } = {}
) {
    const hydrated = await loadHydratedWorkflowMedia(workflowId, {
        workflowMediaRepository,
        mediaRepository,
    });
    if (hydrated.length === 0) return [];

    const excludeSet = new Set((Array.isArray(excludeRoles) ? excludeRoles : []).map((r) => String(r).toLowerCase()));
    const rolePriority = new Map(
        (Array.isArray(preferredRoles) ? preferredRoles : []).map((r, idx) => [String(r).toLowerCase(), idx])
    );
    const defaultRank = rolePriority.size;

    const validItems = hydrated.filter((item) => {
        if (!isCompletedHttpMedia(item)) return false;
        const role = String(item.role || item.mediaRole || "").toLowerCase();
        if (role && excludeSet.has(role)) return false;
        return true;
    });

    validItems.sort((a, b) => {
        const aPrimary = a.is_primary || a.isPrimary ? 0 : 1;
        const bPrimary = b.is_primary || b.isPrimary ? 0 : 1;
        if (aPrimary !== bPrimary) return aPrimary - bPrimary;

        const aRole = String(a.role || a.mediaRole || "").toLowerCase();
        const bRole = String(b.role || b.mediaRole || "").toLowerCase();
        const aRank = rolePriority.has(aRole) ? rolePriority.get(aRole) : defaultRank;
        const bRank = rolePriority.has(bRole) ? rolePriority.get(bRole) : defaultRank;
        return aRank - bRank;
    });

    const seenUrls = new Set();
    const results = [];
    for (const item of validItems) {
        const dto = toWorkflowVisualDto(item);
        if (seenUrls.has(dto.url)) continue;
        seenUrls.add(dto.url);
        results.push(dto);
    }

    return results;
}

/**
 * Resolves the canonical single visual media for a workflow:
 *   1. The workflow's `is_primary = true` media if `status === 'success'` with valid HTTP(S) `url`.
 *   2. If primary is failed/saved/missing URL, falls back to its `generation_config.source_media_id`
 *      on the same workflow (if valid `success` and not excluded), otherwise the latest completed
 *      non-excluded media on that workflow.
 *
 * @param {string} workflowId
 * @param {Object} [options]
 * @param {string[]} [options.excludeRoles=["reference"]]
 * @param {Object|null} [options.workflowMediaRepository]
 * @param {Object|null} [options.mediaRepository]
 * @returns {Promise<{ mediaId: string|null, id: string|null, url: string, role: string|null, isPrimary: boolean, status: string, width: number|null, height: number|null }|null>}
 */
export async function getWorkflowPrimaryMedia(
    workflowId,
    {
        excludeRoles = ["reference"],
        workflowMediaRepository = null,
        mediaRepository = null,
    } = {}
) {
    const hydrated = await loadHydratedWorkflowMedia(workflowId, {
        workflowMediaRepository,
        mediaRepository,
    });
    if (hydrated.length === 0) return null;

    const excludeSet = new Set((Array.isArray(excludeRoles) ? excludeRoles : []).map((r) => String(r).toLowerCase()));
    const isEligible = (item) => {
        if (!isCompletedHttpMedia(item)) return false;
        const role = String(item.role || item.mediaRole || "").toLowerCase();
        return !(role && excludeSet.has(role));
    };

    const primary = hydrated.find((item) => item.is_primary === true || item.isPrimary === true);
    if (primary && isEligible(primary)) {
        return toWorkflowVisualDto(primary);
    }

    const refSourceId =
        typeof primary?.generation_config?.source_media_id === "string" &&
        primary.generation_config.source_media_id.trim()
            ? primary.generation_config.source_media_id.trim()
            : null;
    if (refSourceId) {
        const directSource = hydrated.find(
            (item) => (item.id || item.media_id) === refSourceId && isEligible(item)
        );
        if (directSource) {
            return toWorkflowVisualDto(directSource);
        }
    }

    for (let i = hydrated.length - 1; i >= 0; i--) {
        if (isEligible(hydrated[i])) {
            return toWorkflowVisualDto(hydrated[i]);
        }
    }

    return null;
}

/**
 * Deletes a media item from DB and unlinks its workflow association.
 *
 * @param {Object} params
 * @param {string} params.mediaId
 * @param {string} [params.workflowId]
 * @returns {Promise<{ deleted: boolean, mediaId: string }>}
 */
export async function deleteMedia({ mediaId, workflowId = null } = {}) {
    if (!mediaId) throw new MediaValidationError("mediaId is required for deleteMedia");

    const repo = getMediaRepository();
    if (typeof repo?.findById === "function") {
        const record = await repo.findById(mediaId);
        if (isMediaInFlight(record)) {
            throw new MediaConflictError("Cannot delete media while it is still processing", {
                context: { mediaId, workflowId, status: record.status },
            });
        }
    }
    await repo.deleteByIdAndWorkflow(mediaId, workflowId);

    return { deleted: true, mediaId };
}

// ── Re-exports for Systems & Architecture Compatibility ───────────────────────

export {
    // Save-type registry
    saveTypeRegistry,
    SAVE_TYPES,
    RETENTION_POLICIES,

    // Storage abstractions
    StorageService,
    StoragePathResolver,
    createStorageService,
    IStorageProvider,
    InMemoryStorageProvider,
    SupabaseStorageProvider,
    storagePathResolver,
    StorageError,
    StorageValidationError,
    isStream,

    // Repositories
    MediaRepository,
    WorkflowMediaRepository,
    createMediaInWorkflow,
    linkWorkflowMediaForCreatedRow,
    markMediaStatus,
    createWorkflowWithMedia,
    createWorkflowWithMediaAtomic,
    createGenerationPlaceholderAtomic,
    appendMediaToWorkflow,
    WORKFLOW_MEDIA_ROLES,
    normalizeWorkflowMediaRole,
    inferWorkflowMediaRole,

    // Ingestion & Policies
    MediaUploadService,
    AssetUploadService,
    MediaInspector,
    SourceResolver,
    SourceReader,
    SourcePolicy,
    extractImageMetadata,
    extractVideoMetadata,
    extractMediaMetadata,
    createSizeLimitedMemoryStorage,
    resetActiveUploadsForTest,
    resetInFlightBytesForTest,
    getActiveUploadsCountForTest,
    getInFlightBytesForTest,
    DEFAULT_UPLOAD_POLICY,
    ELEMENT_REFERENCE_UPLOAD_POLICY,
    ELEMENT_SHEET_UPLOAD_POLICY,
    ELEMENT_SOURCES_UPLOAD_POLICY,
    CHARACTER_SHEET_UPLOAD_POLICY,
    CHARACTER_DETAIL_UPLOAD_POLICY,
    UPLOAD_POLICIES,
    createPayloadTooLargeError,
    ValidationError,
    UploadError,
    QuotaError,
    WORKFLOW_REFERENCE_QUOTA_PREFIX,
    WORKFLOW_REFERENCE_QUOTA_PATTERN,
    formatWorkflowReferenceQuotaMessage,
    isWorkflowReferenceQuotaError,

    // Services
    MediaService,
    MediaWorkflowLifecycleService,
    V1StorageBridge,
    MEDIA_WORKFLOW_STATUS,
    MEDIA_IN_FLIGHT_STATUSES,
    isMediaInFlight,
    isMediaFailed,
    hasInFlightMedia,
    areAllWorkflowMediaFailed,
    resolveMediaMetadata,
    calculateAspectRatio,
    failWorkflowPendingMedia,
    normalizeNodeMediaOutputs,

    // Typed Errors
    MediaError,
    MediaValidationError,
    MediaNotFoundError,
    MediaConflictError,
    MediaStorageError,
    MediaUploadError,
    MediaQuotaError,
};

export default {
    createPendingMedia,
    persistExternalMedia,
    completeMedia,
    markMediaFailed,
    linkMediaToEntity,
    getMediaUrls,
    getMediaById,
    getWorkflowVisualMedia,
    getWorkflowPrimaryMedia,
    deleteMedia,
    getMediaRepository,
    getWorkflowMediaRepository,
    getStorageService,
    getMediaUploadService,
    getMediaService,
    getSaveTypeRegistry,
};
