import {
  db,
  storageService,
  promptService,
  IMAGE_MODELS as models,
  dnaTreatment,
} from "../container.js";

import { GenerateImageTreatment } from "#image/treatments/extendtretment/GenerateImageTreatment.js";
import { EditImageTreatment } from "#image/treatments/extendtretment/EditImageTreatment.js";
import { CameraTreatment } from "#image/treatments/extendtretment/CameraEditTreatment.js";
import { LightingTreatment } from "#image/treatments/extendtretment/LightingTreatment.js";
import { UpscaleTreatment } from "#image/treatments/UpscaleTreatment.js";
import { ElementSheetTreatment } from "#image/treatments/extendtretment/ElementSheetTreatment.js";
import { VideoTreatment } from "#video/treatments/VideoTreatment.js";
import { MotionTreatment } from "#video/treatments/MotionTreatment.js";
import { EditVideoTreatment } from "#video/treatments/EditVideoTreatment.js";

export const treatmentDeps = {
  db,
  storageService,
  promptService,
  models,
  dnaTreatment,
};

export function createTreatmentRegistry(deps = treatmentDeps) {
  return {
    GenerateImageTreatment: new GenerateImageTreatment(deps),
    EditImageTreatment: new EditImageTreatment(deps),
    CameraTreatment: new CameraTreatment(deps),
    LightingTreatment: new LightingTreatment(deps),
    UpscaleTreatment: new UpscaleTreatment(deps),
    ElementSheetTreatment: new ElementSheetTreatment(deps),
    VideoTreatment: new VideoTreatment(deps),
    MotionTreatment: new MotionTreatment(deps),
    EditVideoTreatment: new EditVideoTreatment(deps),
  };
}

export function resolveTreatment(type, deps = treatmentDeps) {
  const treatments = createTreatmentRegistry(deps);
  const treatment = treatments[type];

  if (!treatment) {
    throw new Error(`Unknown treatment type "${type}"`);
  }

  return treatment;
}
