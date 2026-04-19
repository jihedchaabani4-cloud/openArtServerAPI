import {
    imageTreatment,
    editImageTreatment,
    cameraTreatment,
    lightingTreatment,
} from "../src/container.js";

/**
 * Chooses the image-domain treatment (standard, cinema, multi-shot, what's next).
 * Video uses VideoTreatment via videoController + container.videoTreatment.
 */
export function resolveImageTreatment(type, section) {

    if (type === "edit") return editImageTreatment;
    if (type === "camera") return cameraTreatment;
    if (type === "lighting") return lightingTreatment;
    return imageTreatment;
}
