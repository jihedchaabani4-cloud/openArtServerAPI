/**
 * System 4: Media & Storage — Public Tools Gateway (Rule 1, Rule 8)
 *
 * @description Exposes clean DTO operations for media creation, external media persistence,
 * linking, URL resolution, asset upload, and storage management.
 */

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

/**
 * Persists external media (e.g., from provider temp URL or raw buffer) to storage
 * and updates the media record to completed status.
 *
 * @param {Object} params
 * @param {string} params.mediaId
 * @param {string|Buffer} params.source
 * @param {string} params.userId
 * @param {string} [params.saveType="default"]
 * @param {Object} [params.metadata]
 * @returns {Promise<{ mediaId: string, url: string, width: number, height: number, ratio: string, status: string }>}
 */
export async function persistExternalMedia({
    mediaId,
    source,
    userId,
    saveType = "default",
    metadata = {},
} = {}) {
    if (!mediaId) throw new MediaValidationError("mediaId is required for persistExternalMedia");
    if (!source) throw new MediaValidationError("source is required for persistExternalMedia");
    if (!userId) throw new MediaValidationError("userId is required for persistExternalMedia");

    const stConfig = saveTypeRegistry.get(saveType);
    const folder = stConfig?.storageFolder || "uploads";
    const uploadService = getMediaUploadService();

    const uploadResults = await uploadService.upload({
        files: [source],
        policy: DEFAULT_UPLOAD_POLICY,
        userId,
        folder,
    });

    const uploaded = uploadResults[0];
    if (!uploaded || !uploaded.url) {
        throw new MediaStorageError("Failed to persist media to cloud storage");
    }

    const repo = getMediaRepository();
    const updated = await repo.updateFields(mediaId, {
        url: uploaded.url,
        width: uploaded.width || metadata.width || 1024,
        height: uploaded.height || metadata.height || 1024,
        status: "success",
        error_message: null,
    });

    return {
        mediaId,
        url: uploaded.url,
        width: updated.width,
        height: updated.height,
        ratio: uploaded.ratio || calculateAspectRatio(updated.width, updated.height),
        status: updated.status,
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
 * @param {boolean} [params.isPrimary=false]
 * @param {Object} [params.metadata]
 * @returns {Promise<Object>} Plain link record
 */
export async function linkMediaToEntity({
    mediaId,
    workflowId,
    role = "output",
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
    resolveMediaMetadata,
    calculateAspectRatio,
    failWorkflowPendingMedia,
    normalizeNodeMediaOutputs,

    // Typed Errors
    MediaError,
    MediaValidationError,
    MediaNotFoundError,
    MediaStorageError,
    MediaUploadError,
    MediaQuotaError,
};

export default {
    createPendingMedia,
    persistExternalMedia,
    markMediaFailed,
    linkMediaToEntity,
    getMediaUrls,
    getMediaById,
    deleteMedia,
    getMediaRepository,
    getWorkflowMediaRepository,
    getStorageService,
    getMediaUploadService,
    getMediaService,
    getSaveTypeRegistry,
};
