import { MediaRepository } from "../db/MediaRepository.js";
import { MediaService } from "./MediaService.js";

let _assetUploadService = null;
let _workflowService = null;
let _db = null;
let _mediaRepo = null;
let _mediaService = null;

export function setMediaServices({ assetUploadService, workflowService, db, mediaRepo, mediaService } = {}) {
    if (assetUploadService) _assetUploadService = assetUploadService;
    if (workflowService) _workflowService = workflowService;
    if (db) _db = db;
    if (mediaRepo) _mediaRepo = mediaRepo;
    if (mediaService) _mediaService = mediaService;
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

export function getMediaService() {
    if (!_mediaService) {
        _mediaService = new MediaService({ mediaRepo: getMediaRepository(), db: _db });
    }
    return _mediaService;
}

