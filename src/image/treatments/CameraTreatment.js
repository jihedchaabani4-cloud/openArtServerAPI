import { GenerateImageTreatment } from "./ImageTreatment.js";
import { getImageModel } from "#image/core/modelRouter.js";
import { runImageGenerationTask } from "../tasks/ImageGenerationTask.js";
import { verifyAndClampParams } from "../utils/treatmentUtils.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

const getRotationText = (r) => {
  if (r === 0)                return "front view";
  if (r > 0   && r <= 45)    return "slightly right angle";
  if (r > 45  && r <= 90)    return "right side view";
  if (r > 90  && r <= 135)   return "rear right view";
  if (r > 135)               return "rear view";
  if (r < 0   && r >= -45)   return "slightly left angle";
  if (r < -45 && r >= -90)   return "left side view";
  if (r < -90 && r >= -135)  return "rear left view";
  return "rear view";
};

const getTiltText = (t) => {
  if (t === 0)              return "eye level";
  if (t > 0  && t <= 30)   return "slightly high angle";
  if (t > 30 && t <= 60)   return "high angle";
  if (t > 60)              return "bird's eye view";
  if (t < 0  && t >= -30)  return "slightly low angle";
  if (t < -30 && t >= -60) return "low angle";
  return "worm's eye view";
};

const getZoomText = (zoom) => {
  if (zoom <= 2) return "extreme close-up";
  if (zoom <= 4) return "close-up";
  if (zoom <= 6) return "medium shot";
  if (zoom <= 8) return "wide shot";
  return "extreme wide shot";
};

const buildCameraPrompt = (rotation, tilt, zoom) => {
  const rotText  = getRotationText(rotation);
  const tiltText = getTiltText(tilt);
  const zoomText = getZoomText(zoom);

  return [
    `${rotText}, ${tiltText}, ${zoomText}`,
    "same subject, same clothing, same environment, same lighting, same art style",
    "photorealistic, cinematic, natural perspective, high detail, consistent identity",
  ].join(", ");
};

// ─── Class ─────────────────────────────────────────────────────────────────

export class CameraTreatment extends GenerateImageTreatment {
  constructor(deps) {
    super(deps);
  }

  async execute(input) {
    let {
      rotation = 0, tilt = 0, zoom = 6,
      project_id, session_id, workflow_id, media_id,
      ratio, quality, model_name = "seedream-pro",
      negative_prompt, steps, guidance_scale,
      seed, userId, references = [],
    } = input;

    // 1. Auto-resolve media_id from references
    if (!media_id && references.length > 0) {
      media_id = references[0].id || references[0].media_id || references[0].asset_id;
    }

    // 2. Auto-resolve workflow_id from media record
    if (!workflow_id && media_id) {
      try {
        const media = await this.db.media.findById(media_id);
        if (media?.workflow_id) {
          workflow_id = media.workflow_id;
          console.log(`✨ [CameraTreatment] Resolved workflow_id: ${workflow_id}`);
        }
      } catch (err) {
        console.warn(`⚠️ [CameraTreatment] Could not resolve workflow_id: ${err.message}`);
      }
    }

    // 3. Guards
    if (!project_id)  throw new Error("project_id required");
    if (!session_id)  throw new Error("session_id required");
    if (!workflow_id) throw new Error("workflow_id required for camera angle edit");

    const startTime = Date.now();

    // 4. Build prompt from numeric values only
    const cameraPrompt = buildCameraPrompt(rotation, tilt, zoom);
    console.log(`🎥 [CameraTreatment] Prompt: "${cameraPrompt}"`);

    // 5. Resolve model & provider
    const route = getImageModel(model_name);
    if (!route) throw new Error(`Model "${model_name}" not found.`);
    const provider = route.i2i || route.t2i;

    // 6. Verify & clamp params
    const verified = verifyAndClampParams(provider, {
      steps, guidance_scale, ratio, quality, count: 1,
    });

    // 7. Process references — ensure base image is first
    let rawRefs = [...references];
    const alreadyHasBase = rawRefs.find(
      r => r.media_id === media_id || r.id === media_id || r.asset_id === media_id
    );
    if (media_id && !alreadyHasBase) {
      rawRefs.unshift({ media_id, role: "IMAGE_INPUT_TYPE_BASE_IMAGE", is_base: true });
    }
    const input_assets = await this.refProcessor.process(
      rawRefs, userId, project_id, session_id, "uploads"
    );

    // 8. Size info
    const sizeInfo = this._getStandardSize(verified.ratio, verified.quality);

    // 9. Create generation config in DB
    const generation_type = "TEXT_BASE_IMAGE_REFERENCES";
    const config = await this.db.configs.createConfig({
      prompt: cameraPrompt,
      model: model_name,
      aspect_ratio: verified.ratio || "LANDSCAPE",
      generation_type,
    });

    // Attach reference records
    for (let i = 0; i < input_assets.length; i++) {
      const asset = input_assets[i];
      if (asset.media_id) {
        await this.db.configs.createReference({
          generation_config_id: config.id,
          position: i,
          input_type: asset.is_base
            ? "IMAGE_INPUT_TYPE_BASE_IMAGE"
            : "IMAGE_INPUT_TYPE_REFERENCE",
          ref_media_id: asset.media_id,
        });
      }
    }

    // 10. Fetch existing workflow
    const wf = await this.db.workflows.getWorkflow(workflow_id);
    if (!wf) throw new Error(`Workflow ${workflow_id} not found`);

    // 11. Fire background task
    const context = {
      promptService:   this.promptService,
      storageService:  this.storageService,
      db:              this.db,
    };

    runImageGenerationTask(context, {
      provider,
      batchId:          null,
      configId:         config.id,
      workflows:        [wf],
      generation_type,
      prompt:           cameraPrompt,
      negative_prompt,
      ratio:            verified.ratio,
      quality:          verified.quality,
      size:             sizeInfo?.size   || null,
      width:            sizeInfo?.width  || null,
      height:           sizeInfo?.height || null,
      userId,
      input_assets,
      startTime,
      steps:            verified.steps,
      guidance_scale:   verified.guidance_scale,
      seed,
      project_id,
      session_id,
      model_name,
      count:            1,
    }).catch(err => {
      console.error(`❌ [CameraTreatment] Unhandled: ${err.message}`);
    });

    // 12. Return immediately
    return {
      batchId:   null,
      configId:  config.id,
      workflows: [wf],
      status:    "processing",
      provider:  `${model_name} → ${provider.constructor.name}`,
    };
  }
}