import { getStandardSize               } from "#utils/sizeUtils.js";
import { getImageModel, ROUTED_IMAGE_MODELS } from "#image/core/modelRouter.js";
import { verifyAndClampParams          } from "../../utils/treatmentUtils.js";
import { appendMediaToWorkflow, markMediaStatus, markMediaFailed } from "#db/workflowMediaOps.js";

/**
 * BaseGenerateImageTreatment
 *
 * Shared foundation for all *generation* treatments
 * (TEXT_ONLY, TEXT_REFERENCES, element sheets, …).
 *
 * Responsibilities:
 *   _resolveProvider()   — model-name → provider object
 *   _getStandardSize()   — ratio + quality → {size, width, height}
 *   _buildDisplayName()  — prompt → human-readable workflow name
 *   _runPrepare()        — full prepare pipeline:
 *                          validate → provider → params → config →
 *                          batch? → workflows → media placeholders → safety
 *   run(task)            — dispatch per-variation via _runVariation()
 *   _runVariation()      — single variation: generate → upload → DB update
 *   execute(input)       — fire-and-forget helper
 *
 * Subclasses override:
 *   prepare(input)       — shape raw input, resolve references, call _runPrepare()
 */
export class BaseGenerateImageTreatment {
  constructor({ promptService, models, storageService, db }) {
    this.promptService  = promptService;
    this.models         = models;
    this.storageService = storageService;
    this.db             = db;
  }

  // ─────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────

  _getStandardSize(ratio, quality) {
    return getStandardSize(ratio, quality);
  }

  _buildDisplayName(prompt, workflow_type) {
    if (!prompt || typeof prompt !== "string") {
      return workflow_type === "ELEMENT_SHEET" ? "Element Sheet" : "Image Generation";
    }

    let displayName = prompt
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (workflow_type === "ELEMENT_SHEET") {
      displayName = displayName
        .replace(/\b(character|element|sprite|asset)\s+sheet\b/gi, "")
        .replace(/\b(reference|turnaround|model)\s+sheet\b/gi, "")
        .replace(/\bsheet\s+of\b/gi, "")
        .replace(/\bsheet\b/gi, "")
        .replace(/\bcharacter\b/gi, "")
        .replace(/\breference\b/gi, "")
        .replace(/\bturnaround\b/gi, "")
        .replace(/\s+/g, " ")
        .replace(/^[,:;.\-\s]+|[,:;.\-\s]+$/g, "")
        .trim();
    }

    if (!displayName) {
      return workflow_type === "ELEMENT_SHEET" ? "Element Sheet" : "Image Generation";
    }

    return displayName.substring(0, 60);
  }

  _resolveProvider(model_name, references = []) {
    const route      = getImageModel(model_name);
    const modelGroup = route?.group || this.models[model_name];

    if (!modelGroup && !route) {
      throw new Error(
        `Model "${model_name}" not found. Available: ${ROUTED_IMAGE_MODELS.join(", ")}`
      );
    }

    const isMulti    = references.length > 1;
    const variantKey = references.length > 0 ? (isMulti ? "i2iMulti" : "i2i") : "t2i";

    const provider =
      route?.[variantKey] ||
      (references.length > 0 && route?.i2i) ||
      route?.t2i ||
      modelGroup?.[variantKey] ||
      modelGroup?.i2i ||
      modelGroup?.t2i ||
      modelGroup;

    if (!provider) throw new Error(`Provider not found for model "${model_name}"`);
    if (!["t2i", "i2i"].includes(provider.type)) {
      throw new Error(`Model "${model_name}" is a video model.`);
    }
    return provider;
  }

  // ─────────────────────────────────────────────────────────
  // 🔥 CORE PREPARE  (shared by all generate subclasses)
  // ─────────────────────────────────────────────────────────

  /**
   * _runPrepare — validates, creates DB records, returns a plain
   * JSON-serialisable task descriptor safe to enqueue in Redis.
   *
   * @param {object} opts
   * @param {string}   opts.prompt
   * @param {string}   [opts.prompt_optimise]
   * @param {string}   [opts.display_name]
   * @param {string}   [opts.negative_prompt]
   * @param {string}   opts.model_name
   * @param {string}   [opts.workflow_type]
   * @param {string}   [opts.ratio]
   * @param {string}   [opts.quality]
   * @param {number}   [opts.steps]
   * @param {number}   [opts.guidance_scale]
   * @param {number}   [opts.count]
   * @param {number}   [opts.seed]
   * @param {number}   [opts.strength]
   * @param {string}   opts.userId
   * @param {string}   opts.project_id
   * @param {string}   [opts.session_id]
   * @param {Array}    [opts.input_assets]  — pre-resolved {url, role, is_base}[]
   * @param {string}   [opts.stepId]        — default "GEN"
   */
  async _runPrepare({
    prompt,
    prompt_optimise = null,
    display_name    = null,
    negative_prompt = "",
    model_name,
    workflow_type   = "GENERATION",
    ratio,
    quality,
    steps,
    guidance_scale,
    count           = 1,
    seed,
    strength,
    userId,
    project_id,
    session_id,
    input_assets    = [],   // ✅ already resolved [{url, role, is_base}]
    stepId          = "GEN",
  }) {
    // 1. Provider
    const provider = this._resolveProvider(model_name, input_assets);

    // 2. Verify & clamp params
    const verified = verifyAndClampParams(provider, {
      steps, guidance_scale, ratio, quality, count,
    });

    // 3. Size
    const sizeInfo = this._getStandardSize(verified.ratio, verified.quality);

    // 4. Generation type
    const generation_type = input_assets.length > 0 ? "TEXT_REFERENCES" : "TEXT_ONLY";

    console.log(
      `[${this.constructor.name}] prepare | type:${generation_type} | refs:${input_assets.length} | count:${verified.count}`
    );

    // 5. Generation config
    const config = await this.db.configs.createConfig({
      prompt,
      prompt_optimise,
      model:           model_name,
      aspect_ratio:    verified.ratio || "LANDSCAPE",
      generation_type,
    });

    // 6. Batch (only when count > 1)
    let batch = null;
    if (verified.count > 1) {
      batch = await this.db.batches.createBatch({
        project_id,
        session_id,
        generation_config_id: config.id,
        variation_count:      verified.count,
      });
    }

    // 7. Workflows
    const resolvedDisplayName = display_name || this._buildDisplayName(prompt, workflow_type);
    const workflows = [];
    for (let i = 0; i < verified.count; i++) {
      const wf = await this.db.workflows.createWorkflow({
        project_id,
        session_id,
        batch_id:        batch?.id || null,
        display_name:    resolvedDisplayName,
        variation_index: i,
        workflow_type,
      });
      workflows.push(wf);
    }

    // 8. Media placeholders
    const mediaIds = [];
    for (const wf of workflows) {
      const media = await appendMediaToWorkflow(this.db, {
        workflow_id: wf.id,
        mediaData: {
          project_id,
          generation_config_id: config.id,
          step_id: stepId,
          url:     null,
          width:   sizeInfo?.width  || 1024,
          height:  sizeInfo?.height || 1024,
        },
        initialStatus: "processing",
      });
      mediaIds.push(media.id);
    }

    // 9. Safety check
    const promptForGeneration = prompt_optimise || prompt;
    if (promptForGeneration) {
      const safety = await this.promptService.checkPrompt(promptForGeneration);
      if (!safety.safe) {
        for (const id of mediaIds) {
          await markMediaFailed(this.db, id, safety.reason);
        }
        throw new Error(`Prompt rejected: ${safety.reason}`);
      }
    }

    return {
      userId,
      project_id,
      session_id,
      model_name,
      prompt,
      prompt_optimise,
      negative_prompt,
      generation_type,
      ratio:          verified.ratio,
      quality:        verified.quality,
      steps:          verified.steps,
      guidance_scale: verified.guidance_scale,
      count:          verified.count,
      seed,
      strength,
      size:    sizeInfo?.size   || null,
      width:   sizeInfo?.width  || null,
      height:  sizeInfo?.height || null,
      input_assets,           // ✅ URLs only — safe for Redis
      configId:  config.id,
      batchId:   batch?.id || null,
      workflows,
      mediaIds,
    };
  }

  // ─────────────────────────────────────────────────────────
  // 🔥 RUN  (dispatches per-variation)
  // ─────────────────────────────────────────────────────────

  async run(task) {
    const {
      model_name,
      prompt, prompt_optimise, negative_prompt,
      ratio, quality,
      input_assets,
      batchId, configId,
      workflows, mediaIds,
    } = task;

    const provider = this._resolveProvider(model_name, input_assets);

    // Prompt enhancement (best-effort)
    const promptForGeneration = prompt_optimise || prompt;
    let finalPrompt   = promptForGeneration;
    let finalNegative = negative_prompt;

    try {
      const enhanced = await this.promptService.upscalePrompt(promptForGeneration, { quality });
      finalPrompt    = enhanced.enhanced;
      const autoNeg  = await this.promptService.generateNegativePrompt(finalPrompt);
      finalNegative  = [negative_prompt || "", autoNeg || ""].filter(Boolean).join(", ");
    } catch (err) {
      console.error(`[${this.constructor.name}] Prompt enhancement failed: ${err.message}`);
    }

    const results = await Promise.allSettled(
      workflows.map((workflow, i) =>
        this._runVariation({
          ...task,
          provider,
          workflow,
          mediaId:           mediaIds[i],
          enhanced_prompt:   finalPrompt,
          enhanced_negative: finalNegative,
          variationIndex:    i,
        })
      )
    );

    const succeeded = results.filter(r => r.status === "fulfilled").length;
    const failed    = results.filter(r => r.status === "rejected").length;

    if (succeeded === 0) {
      const firstErr = results.find(r => r.status === "rejected");
      throw new Error(firstErr?.reason?.message || "All variations failed");
    }

    return { batchId, configId, succeeded, failed };
  }

  // ─────────────────────────────────────────────────────────
  // 🔥 _runVariation  (single image — override if needed)
  // ─────────────────────────────────────────────────────────

  async _runVariation({
    provider, workflow, mediaId,
    userId, model_name,
    prompt, enhanced_prompt, enhanced_negative,
    ratio, quality, size, width, height,
    steps, guidance_scale, seed, strength,
    input_assets,
    configId, variationIndex,
  }) {
    try {
      const sourceAsset = (input_assets || []).find(
        a => ["source", "normal", "start", "base"].includes(a.role)
      ) || input_assets[0];

      const image_url = sourceAsset?.url || null;

      const form = {
        prompt:          enhanced_prompt,
        negativePrompt:  enhanced_negative,
        negative_prompt: enhanced_negative,
        ratio, quality, size, width, height,
        steps:           steps          || 20,
        guidanceScale:   guidance_scale || 7.5,
        guidance_scale:  guidance_scale || 7.5,
        seed,
        strength:        strength || 0.8,
        image:           image_url,
        image_url,
        references:      input_assets,
        index:           variationIndex,
      };

      let payload;
      if (typeof provider.buildPayload === "function")      payload = provider.buildPayload(form);
      else if (typeof provider.adapt === "function") {
        const adapted = provider.adapt(form);
        payload = provider.toPayload ? provider.toPayload(adapted) : adapted;
      } else payload = form;

      const result    = await provider.generate(payload);
      const outputUrl = result.image_url || result.url;
      if (!outputUrl) throw new Error("Provider returned no output URL");

      const fileName = `${userId}/generations/${workflow.id}_${Date.now()}.png`;
      const fileUrl  = await this.storageService.uploadFromUrl(fileName, outputUrl);

      // Per-variation config (stores the actual seed used)
      const mediaConfig = await this.db.configs.createConfig({
        prompt,
        model:           model_name,
        aspect_ratio:    ratio || "LANDSCAPE",
        generation_type: input_assets.length > 0 ? "TEXT_REFERENCES" : "TEXT_ONLY",
        seed:            result.seed || seed || null,
      });

      await this.db.media.updateFields(mediaId, {
        generation_config_id: mediaConfig.id,
        url:    fileUrl,
        width:  result.width  || width  || 1024,
        height: result.height || height || 1024,
      });
      await markMediaStatus(this.db, mediaId, "success");

      return { fileUrl, mediaId, workflowId: workflow.id };
    } catch (err) {
      await markMediaFailed(this.db, mediaId, err);
      throw err;
    }
  }

  // ─────────────────────────────────────────────────────────
  // execute — fire-and-forget (subclasses can override)
  // ─────────────────────────────────────────────────────────

  async execute(input) {
    const task = await this.prepare(input);

    this.run(task).catch(err =>
      console.error(`[${this.constructor.name}] background error: ${err.message}`)
    );

    return {
      batchId:   task.batchId,
      configId:  task.configId,
      workflows: task.workflows,
      status:    "processing",
      provider:  task.model_name,
    };
  }
}