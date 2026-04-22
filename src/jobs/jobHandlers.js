import { CameraTreatment } from "#image/treatments/extendtretment/CameraEditTreatment.js";
import { GenerateImageTreatment } from "#image/treatments/extendtretment/GenerateImageTreatment.js";
import { EditImageTreatment } from "#image/treatments/extendtretment/EditImageTreatment.js";
import { LightingTreatment } from "#image/treatments/extendtretment/LightingTreatment.js";
import { UpscaleTreatment } from "#image/treatments/UpscaleTreatment.js";
import { ElementSheetTreatment } from "#image/treatments/extendtretment/ElementSheetTreatment.js";

import { VideoTreatment } from "#video/treatments/VideoTreatment.js";
import { MotionTreatment } from "#video/treatments/MotionTreatment.js";
import { EditVideoTreatment } from "#video/treatments/EditVideoTreatment.js";

/**
 * Maps incoming job names directly to Treatment execution functions.
 */
export const jobHandlers = {
  // --- Image Tasks ---
  "generate-image": async (data, deps) => {
    const treatment = new GenerateImageTreatment(deps);
    if (data.task) return await treatment.runJob(data.task);
    const task = await treatment.prepare(data);
    return await treatment.runJob(task);
  },
  "edit-image": async (data, deps) => {
    const treatment = new EditImageTreatment(deps);
    if (data.task) return await treatment.runJob(data.task);
    const task = await treatment.prepare(data);
    return await treatment.runJob(task);
  },
  "camera-edit": async (data, deps) => {
    const treatment = new CameraTreatment(deps);
    if (data.task) return await treatment.runJob(data.task);
    const task = await treatment.prepare(data);
    return await treatment.runJob(task);
  },
  "lighting-edit": async (data, deps) => {
    const treatment = new LightingTreatment(deps);
    if (data.task) return await treatment.runJob(data.task);
    const task = await treatment.prepare(data);
    return await treatment.runJob(task);
  },
  "upscale-image": async (data, deps) => {
    const treatment = new UpscaleTreatment(deps);
    if (data.task) return await treatment.runJob(data.task);
    const task = await treatment.prepare(data);
    return await treatment.runJob(task);
  },
  "element-sheet": async (data, deps) => {
    const treatment = new ElementSheetTreatment(deps);
    if (data.task) return await treatment.runJob(data.task);
    const task = await treatment.prepare(data);
    return await treatment.runJob(task);
  },

  // --- Video Tasks ---
  "generate-video": async (data, deps) => {
    const treatment = new VideoTreatment(deps);
    return await treatment.prepare(data);
  },
  "motion-video": async (data, deps) => {
    const treatment = new MotionTreatment(deps);
    return await treatment.prepare(data);
  },
  "edit-video": async (data, deps) => {
    const treatment = new EditVideoTreatment(deps);
    return await treatment.prepare(data);
  }
};
