export const MIGRATION_STATUSES = Object.freeze({
  NOT_STARTED: "not_started",
  IN_PROGRESS: "in_progress",
  PASSED: "passed",
  FAILED: "failed",
});

export const LEGACY_PATH_STATUSES = Object.freeze({
  ACTIVE: "active",
  ROLLBACK_WINDOW: "rollback_window",
  DISABLED: "disabled",
  REMOVED: "removed",
});

export const migrationInventory = [
  {
    featureId: "image-generation",
    legacyEntryPoints: ["apiOpenArt/routes/images.js", "apiOpenArt/controllers/imageController.js"],
    targetRegistryEntry: "first-slice-image-generation",
    targetWorkflowId: "first-slice-image-generation",
    sharedSteps: ["GenerateImageTreatment"],
    capabilities: ["image-generation"],
    providers: ["image-runners"],
    parityChecklist: ["success", "failure", "billing", "storage", "status", "events"],
    parityStatus: MIGRATION_STATUSES.PASSED,
    legacyPathStatus: LEGACY_PATH_STATUSES.ROLLBACK_WINDOW,
    rollbackWindowUntil: "2026-06-29T14:00:00Z",
  },
  {
    featureId: "image-editing",
    legacyEntryPoints: ["apiOpenArt/routes/images.js", "apiOpenArt/controllers/editImageController.js"],
    targetRegistryEntry: "image-editing",
    targetWorkflowId: "image-editing",
    sharedSteps: ["EditImageTreatment"],
    capabilities: ["image-editing"],
    providers: ["image-runners"],
    parityChecklist: ["success", "failure", "billing", "storage", "status", "events"],
    parityStatus: MIGRATION_STATUSES.NOT_STARTED,
    legacyPathStatus: LEGACY_PATH_STATUSES.ACTIVE,
    rollbackWindowUntil: null,
  },
  {
    featureId: "video-generation",
    legacyEntryPoints: ["apiOpenArt/routes/video.js", "apiOpenArt/controllers/videoController.js"],
    targetRegistryEntry: "first-slice-video-generation",
    targetWorkflowId: "first-slice-video-generation",
    sharedSteps: ["VideoTreatment"],
    capabilities: ["video-generation"],
    providers: ["video-runners"],
    parityChecklist: ["success", "failure", "billing", "storage", "status", "events"],
    parityStatus: MIGRATION_STATUSES.PASSED,
    legacyPathStatus: LEGACY_PATH_STATUSES.ROLLBACK_WINDOW,
    rollbackWindowUntil: "2026-06-29T14:00:00Z",
  },
  {
    featureId: "video-extension",
    legacyEntryPoints: ["apiOpenArt/routes/video.js", "apiOpenArt/controllers/videoController.js"],
    targetRegistryEntry: "video-extension",
    targetWorkflowId: "video-extension",
    sharedSteps: ["EditVideoTreatment"],
    capabilities: ["video-generation"],
    providers: ["video-runners"],
    parityChecklist: ["success", "failure", "billing", "storage", "status", "events"],
    parityStatus: MIGRATION_STATUSES.NOT_STARTED,
    legacyPathStatus: LEGACY_PATH_STATUSES.ACTIVE,
    rollbackWindowUntil: null,
  },
  {
    featureId: "video-editing",
    legacyEntryPoints: ["apiOpenArt/routes/video.js", "apiOpenArt/controllers/videoController.js"],
    targetRegistryEntry: "video-editing",
    targetWorkflowId: "video-editing",
    sharedSteps: ["EditVideoTreatment"],
    capabilities: ["video-generation"],
    providers: ["video-runners"],
    parityChecklist: ["success", "failure", "billing", "storage", "status", "events"],
    parityStatus: MIGRATION_STATUSES.NOT_STARTED,
    legacyPathStatus: LEGACY_PATH_STATUSES.ACTIVE,
    rollbackWindowUntil: null,
  },
  {
    featureId: "motion-control",
    legacyEntryPoints: ["apiOpenArt/routes/video.js", "apiOpenArt/controllers/videoController.js"],
    targetRegistryEntry: "motion-control",
    targetWorkflowId: "motion-control",
    sharedSteps: ["MotionTreatment"],
    capabilities: ["video-generation"],
    providers: ["video-runners"],
    parityChecklist: ["success", "failure", "billing", "storage", "status", "events"],
    parityStatus: MIGRATION_STATUSES.NOT_STARTED,
    legacyPathStatus: LEGACY_PATH_STATUSES.ACTIVE,
    rollbackWindowUntil: null,
  },
];

export function listMigrationInventory() {
  return migrationInventory.map((item) => ({ ...item }));
}

export function findMigrationInventoryItem(featureId) {
  return migrationInventory.find((item) => item.featureId === featureId || item.targetRegistryEntry === featureId) || null;
}

export function updateParityStatus(featureId, status) {
  const item = migrationInventory.find((i) => i.featureId === featureId);
  if (item) {
    if (Object.values(MIGRATION_STATUSES).includes(status)) {
      item.parityStatus = status;
      return true;
    }
  }
  return false;
}

export function updateLegacyPathStatus(featureId, status, rollbackWindowUntil = null) {
  const item = migrationInventory.find((i) => i.featureId === featureId);
  if (item) {
    if (Object.values(LEGACY_PATH_STATUSES).includes(status)) {
      item.legacyPathStatus = status;
      if (rollbackWindowUntil) {
        item.rollbackWindowUntil = rollbackWindowUntil;
      }
      return true;
    }
  }
  return false;
}

