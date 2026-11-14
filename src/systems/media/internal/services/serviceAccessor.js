let _assetUploadService = null;
let _workflowService = null;
let _db = null;

export function setMediaServices({ assetUploadService, workflowService, db } = {}) {
    if (assetUploadService) _assetUploadService = assetUploadService;
    if (workflowService) _workflowService = workflowService;
    if (db) _db = db;
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
