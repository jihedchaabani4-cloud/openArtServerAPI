import { MediaRepository } from "../db/MediaRepository.js";

let _assetUploadService = null;
let _workflowService = null;
let _db = null;
let _mediaRepo = null;

export function setMediaServices({ assetUploadService, workflowService, db, mediaRepo } = {}) {
    if (assetUploadService) _assetUploadService = assetUploadService;
    if (workflowService) _workflowService = workflowService;
    if (db) _db = db;
    if (mediaRepo) _mediaRepo = mediaRepo;
}

export function getAssetUploadService() {
    return _assetUploadService;
}

export function getWorkflowService() {
    return _workflowService;
}

export function getMediaDb() {
    return _db;
}

export function getMediaRepository() {
    if (!_mediaRepo) {
        _mediaRepo = new MediaRepository();
    }
    return _mediaRepo;
}

