import { ReferenceProcessor } from "#utils/ReferenceProcessor.js";
import { getImageModel, ROUTED_IMAGE_MODELS } from "#image/core/modelRouter.js";
import { verifyAndClampParams } from "../utils/treatmentUtils.js";
import { appendMediaToWorkflow, markMediaStatus } from "#db/workflowMediaOps.js";
import { getStandardSize } from "#utils/sizeUtils.js";

// ─── Helpers ───────────────────────────────────────────────────────────────

const getRotationText = (r) => {
  if (r === 0) return "front view";
  if (r > 0 && r <= 45) return "slightly right angle";
  if (r > 45 && r <= 90) return "right side view";
  if (r > 90 && r <= 135) return "rear right view";
  if (r > 135) return "rear view";
  if (r < 0 && r >= -45) return "slightly left angle";
  if (r < -45 && r >= -90) return "left side view";
  if (r < -90 && r >= -135) return "rear left view";
  return "rear view";
};

const getTiltText = (t) => {
  if (t === 0) return "eye level";
  if (t > 0 && t <= 30) return "slightly high angle";
  if (t > 30 && t <= 60) return "high angle";
  if (t > 60) return "bird's eye view";
  if (t < 0 && t >= -30) return "slightly low angle";
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
  const rotText = getRotationText(rotation);
  const tiltText = getTiltText(tilt);
  const zoomText = getZoomText(zoom);

  return [
    `${rotText}, ${tiltText}, ${zoomText}`,
    "same subject, same clothing, same environment, same lighting, same art style",
    "photorealistic, cinematic, natural perspective, high detail, consistent identity",
  ].join(", ");
};

// ─── Class ─────────────────────────────────────────────────────────────────

export class CameraTreatment {
  constructor({ promptService, models, storageService, db }) {
    this.promptService = promptService;
    this.models = models;
    this.storageService = storageService;
    this.db = db;
    this.refProcessor = new ReferenceProcessor({ storageService, db });
  }

  _getStandardSize(ratio, quality) {
    return getStandardSize(ratio, quality);
  }

  _resolveProvider(model_name, input) {
    const { image_base64, references = [], edit_type } = input;
    const route = getImageModel(model_name);
    const modelGroup = route?.group || this.models[model_name];

    if (!modelGroup && !route) {
        throw new Error(`Model "${model_name}" not found. Available: ${ROUTED_IMAGE_MODELS.join(", ")}`);
    }

    const hasBase = !!image_base64;
    const hasRefs = references.length > 0 || hasBase;
    const isMulti = references.length > 1;
    const variantKey = hasRefs ? (isMulti ? "i2iMulti" : "i2i") : "t2i";

    let provider;
    if (route && route[variantKey]) provider = route[variantKey];
    else if (route && route["i2i"] && hasRefs) provider = route["i2i"];
    else if (route && route["t2i"]) provider = route["t2i"];
    else if (modelGroup?.resolve) provider = modelGroup.resolve({ references, image_base64, edit_type });
    else if (modelGroup) provider = modelGroup[variantKey] || (hasRefs ? modelGroup.i2i : null) || modelGroup.t2i || modelGroup;
    else provider = modelGroup;

    if (!["t2i", "i2i"].includes(provider.type)) {
        throw new Error(`Model "${model_name}" is a video model.`);
    }
    return provider;
  }

  async prepare(input) {
    let {
      rotation = 0, tilt = 0, zoom = 6,
      project_id, session_id, workflow_id,
      ratio, quality, model_name = "seedream-pro",
      negative_prompt, steps, guidance_scale,
      seed, userId
    } = input;

    if (!workflow_id) throw new Error("workflow_id required for camera angle edit");

    const sourceMedia = await this.db.media.findLatestByWorkflow(workflow_id);
    if (!sourceMedia) throw new Error(`No media found for workflow ${workflow_id}`);
    if (!sourceMedia.url) throw new Error(`Source media has no final URL yet.`);

    const cameraPrompt = buildCameraPrompt(rotation, tilt, zoom);
    console.log(`🎥 [CameraTreatment] Prompt: "${cameraPrompt}"`);

    const provider = this._resolveProvider(model_name, { references: [{ is_base: true }] });

    const verified = verifyAndClampParams(provider, {
      steps, guidance_scale, ratio, quality, count: 1,
    });

    const input_assets = await this.refProcessor.process([{
        url: sourceMedia.url,
        media_id: sourceMedia.id,
        role: "source",
        is_base: true
    }], userId, project_id, session_id, "uploads");

    const sizeInfo = this._getStandardSize(verified.ratio, verified.quality);

    const generation_type = "TEXT_BASE_IMAGE_REFERENCES";
    const config = await this.db.configs.createConfig({
      prompt: cameraPrompt,
      model: model_name,
      aspect_ratio: verified.ratio || "LANDSCAPE",
      generation_type,
    });

    for (let i = 0; i < input_assets.length; i++) {
        const asset = input_assets[i];
        if (asset.media_id) {
            await this.db.configs.createReference({
                generation_config_id: config.id,
                position: i,
                input_type: asset.is_base ? "IMAGE_INPUT_TYPE_BASE_IMAGE" : "IMAGE_INPUT_TYPE_REFERENCE",
                ref_media_id: asset.media_id,
            });
        }
    }

    const wf = await this.db.workflows.getWorkflow(workflow_id);
    if (!wf) throw new Error(`Workflow ${workflow_id} not found`);

    const media = await appendMediaToWorkflow(this.db, {
        workflow_id: wf.id,
        mediaData: {
            project_id,
            generation_config_id: config.id,
            step_id: "CAE",
            url: null,
            width: sizeInfo?.width || 1024,
            height: sizeInfo?.height || 1024,
        },
        initialStatus: "processing",
    });

    return {
        userId, project_id, session_id, model_name,
        prompt: cameraPrompt, negative_prompt, generation_type,
        ratio: verified.ratio, quality: verified.quality,
        steps: verified.steps, guidance_scale: verified.guidance_scale,
        size: sizeInfo?.size, width: sizeInfo?.width, height: sizeInfo?.height,
        seed, input_assets,
        configId: config.id,
        workflows: [wf],
        mediaIds: [media.id],
    };
  }

  async run(task) {
    const {
        userId, model_name, prompt, negative_prompt, generation_type,
        ratio, quality, size, width, height, steps, guidance_scale,
        seed, input_assets, configId, workflows, mediaIds,
    } = task;

    const provider = this._resolveProvider(model_name, { references: input_assets });
    const sourceAsset = (input_assets || []).find(a => ["source", "normal", "start", "base"].includes(a.role)) || input_assets[0];
    const image_url = sourceAsset?.url || null;

    const workflow = workflows[0];
    const mediaId = mediaIds[0];

    try {
        const form = {
            prompt,
            negativePrompt: negative_prompt,
            negative_prompt,
            ratio, quality, size, width, height,
            steps: steps || 20,
            guidanceScale: guidance_scale || 7.5,
            guidance_scale: guidance_scale || 7.5,
            seed,
            image: image_url,
            image_url,
            references: input_assets,
        };

        let payload;
        if (typeof provider.buildPayload === "function") payload = provider.buildPayload(form);
        else if (typeof provider.adapt === "function") {
            const adapted = provider.adapt(form);
            payload = provider.toPayload ? provider.toPayload(adapted) : adapted;
        } else payload = form;

        const result = await provider.generate(payload);
        const outputUrl = result.image_url || result.url;
        if (!outputUrl) throw new Error("Provider returned no output URL");

        const ext = "png";
        const fileName = `${userId}/generations/camera_${workflow.id}_${Date.now()}.${ext}`;
        const fileUrl = await this.storageService.uploadFromUrl(fileName, outputUrl);

        const mediaConfig = await this.db.configs.createConfig({
            prompt, model: model_name, aspect_ratio: ratio, generation_type, seed: result.seed || seed || null,
        });

        await this.db.media.updateFields(mediaId, {
            generation_config_id: mediaConfig.id, url: fileUrl,
            width: result.width || width || 1024, height: result.height || height || 1024,
        });
        await markMediaStatus(this.db, mediaId, "success");

        return { configId, succeeded: 1, failed: 0 };
    } catch (err) {
        await markMediaStatus(this.db, mediaId, "failed", err.message);
        throw err;
    }
  }

  async execute(input) {
    const task = await this.prepare(input);
    this.run(task).catch(err => console.error(`[CameraTreatment] background error: ${err.message}`));
    return {
        batchId: null,
        configId: task.configId,
        workflows: task.workflows,
        status: "processing",
        provider: task.model_name,
    };
  }
}