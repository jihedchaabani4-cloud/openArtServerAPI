import { getStandardSize } from "#utils/sizeUtils.js";
import { getImageModel, ROUTED_IMAGE_MODELS } from "#image/core/modelRouter.js";
import { verifyAndClampParams } from "../../utils/treatmentUtils.js";
import { appendMediaToWorkflow, markMediaStatus, markMediaFailed } from "#db/workflowMediaOps.js";

export class BaseEditTreatment {
  constructor({ promptService, models, storageService, db }) {
    this.promptService  = promptService;
    this.models         = models;
    this.storageService = storageService;
    this.db             = db;
  }

  // ─────────────────────────────────────────────────────────
  _getStandardSize(ratio, quality) {
    return getStandardSize(ratio, quality);
  }

  _resolveProvider(model_name, input) {
    const { image_base64, references = [] } = input;
    const route      = getImageModel(model_name);
    const modelGroup = route?.group || this.models[model_name];

    if (!modelGroup && !route) {
      throw new Error(`Model "${model_name}" not found. Available: ${ROUTED_IMAGE_MODELS.join(", ")}`);
    }

    const hasRefs    = references.length > 0 || !!image_base64;
    const isMulti    = references.length > 1;
    const variantKey = hasRefs ? (isMulti ? "i2iMulti" : "i2i") : "t2i";

    let provider =
      route?.[variantKey] ||
      (hasRefs && route?.i2i) ||
      route?.t2i ||
      modelGroup?.[variantKey] ||
      modelGroup?.i2i ||
      modelGroup?.t2i ||
      modelGroup;

    if (!provider) throw new Error(`Provider not found for model "${model_name}"`);
    if (!["t2i", "i2i"].includes(provider.type)) {
      throw new Error(`Model "${model_name}" is not an image model`);
    }

    return provider;
  }

  // ─────────────────────────────────────────────────────────
  // 🔥 CORE PREPARE (shared)
  // ─────────────────────────────────────────────────────────
  async _runPrepare({
    prompt,
    references, // ⚡ already URLs
    model_name,
    ratio,
    quality,
    seed,
    steps,
    guidance_scale,
    negative_prompt,
    upscaleScale,
    userId,
    project_id,
    session_id,
    workflow_id,
    stepId,
  }) {
    // 1. Normalize refs (NO media_id anymore)
    const input_assets = (references || []).map(r => ({
      url: r.url,
      role: r.role || "reference",
      is_base: !!r.is_base,
    }));

    // 2. Provider
    const provider = this._resolveProvider(model_name, { references: input_assets });

    // 3. Params
    const verified = verifyAndClampParams(provider, {
      steps, guidance_scale, ratio, quality, count: 1,
    });

    // 4. Size
    const sizeInfo = this._getStandardSize(verified.ratio, verified.quality);

    // 5. generation_type
    const generation_type = input_assets.length > 0 ? "TEXT_REFERENCES" : "TEXT_ONLY";

    // 6. Config
    const config = await this.db.configs.createConfig({
      prompt,
      model: model_name,
      aspect_ratio: verified.ratio || "LANDSCAPE",
      generation_type,
    });

    // 7. Workflow
    const wf = await this.db.workflows.getWorkflow(workflow_id);
    if (!wf) throw new Error(`Workflow "${workflow_id}" not found`);

    // 8. Media placeholder
    const media = await appendMediaToWorkflow(this.db, {
      workflow_id: wf.id,
      mediaData: {
        project_id,
        generation_config_id: config.id,
        step_id: stepId,
        url: null,
        width:  sizeInfo?.width  || 1024,
        height: sizeInfo?.height || 1024,
      },
      initialStatus: "processing",
    });

    // 9. Safety
    if (prompt) {
      const safety = await this.promptService.checkPrompt(prompt);
      if (!safety.safe) {
        await markMediaFailed(this.db, media.id, safety.reason);
        throw new Error(`Prompt rejected: ${safety.reason}`);
      }
    }

    return {
      userId,
      model_name,
      prompt,
      negative_prompt,
      generation_type,
      ratio: verified.ratio,
      quality: verified.quality,
      steps: verified.steps,
      guidance_scale: verified.guidance_scale,
      size: sizeInfo?.size,
      width: sizeInfo?.width,
      height: sizeInfo?.height,
      seed,
      input_assets, // ✅ URLs only
      upscaleScale,
      configId: config.id,
      workflow: wf,
      mediaId: media.id,
    };
  }

  // ─────────────────────────────────────────────────────────
  // 🔥 RUN (PURE — NO DB refs)
  // ─────────────────────────────────────────────────────────
  async run(task) {
    const {
      userId,
      model_name,
      prompt,
      negative_prompt,
      generation_type,
      ratio, quality, size, width, height,
      steps, guidance_scale,
      seed,
      input_assets,
      upscaleScale,
      configId,
      workflow,
      mediaId,
    } = task;

    const provider = this._resolveProvider(model_name, { references: input_assets });

    const sourceAsset =
      input_assets.find(a => a.is_base || a.role === "source") ||
      input_assets[0];

    const image_url = sourceAsset?.url || null;

    const form = {
      prompt,
      negativePrompt: negative_prompt,
      ratio, quality, size, width, height,
      steps: steps || 20,
      guidanceScale: guidance_scale || 7.5,
      seed,
      image: image_url,
      image_url,
      references: input_assets,
      ...(upscaleScale ? { scale: upscaleScale } : {}),
    };

    let payload =
      provider.buildPayload?.(form) ||
      (provider.adapt
        ? (provider.toPayload ? provider.toPayload(provider.adapt(form)) : provider.adapt(form))
        : form);

    let result;
    try {
      result = await provider.generate(payload);
    } catch (err) {
      const msg = err?.response?.data?.detail || err.message;
      await markMediaFailed(this.db, mediaId, msg);
      throw new Error(msg);
    }

    let fileUrl;
    try {
      const fileName = `${userId}/edits/${workflow.id}_${Date.now()}.png`;

      if (result.image_url || result.url) {
        fileUrl = await this.storageService.uploadFromUrl(fileName, result.image_url || result.url);
      } else if (result.image_base64) {
        fileUrl = await this.storageService.upload(fileName, result.image_base64);
      } else {
        throw new Error("No output from provider");
      }
    } catch (err) {
      await markMediaFailed(this.db, mediaId, err);
      throw err;
    }

    await this.db.media.updateFields(mediaId, {
      url: fileUrl,
      width: result.width || width || 1024,
      height: result.height || height || 1024,
    });

    await markMediaStatus(this.db, mediaId, "success");

    return { configId, mediaId, workflowId: workflow.id };
  }

  async execute(input) {
    const task = await this.prepare(input);

    this.run(task).catch(err => {
      console.error(`[${this.constructor.name}] error: ${err.message}`);
    });

    return {
      configId: task.configId,
      workflows: [task.workflow],
      status: "processing",
    };
  }
}
