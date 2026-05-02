import { getStandardSize }                                          from "#utils/sizeUtils.js";
import { calculateImageCredits, getImageModel, ROUTED_IMAGE_MODELS } from "#image/core/modelRouter.js";
import { verifyAndClampParams }                                      from "../../utils/treatmentUtils.js";
import { appendMediaToWorkflow, markMediaStatus, markMediaFailed }   from "#db/workflowMediaOps.js";
import { enqueueTreatmentJob }                                       from "#queue/treatmentJob.js";
import { skipIfMediaAlreadyDone }                                    from "#utils/skipIfMediaAlreadyDone.js";
import { processPrompt }                                             from "#services/promptServiceV2.js"; // 🔥

export class BaseEditTreatment {

  constructor({ promptService, models, storageService, db, walletService = null }) {
    this.promptService  = promptService;
    this.models         = models;
    this.storageService = storageService;
    this.db             = db;
    this.walletService  = walletService;
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

  getQueueType() {
    return this.constructor.name;
  }

  // ─────────────────────────────────────────────────────────
  // 🔥 CORE PREPARE (shared)
  // ─────────────────────────────────────────────────────────
  async _runPrepare({
    prompt,
    references,
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
    // 1. Normalize refs — preserve all fields including DNA + label + type
    const input_assets = (references || []).map(r => ({
      url:      r.url,
      role:     r.role     || "reference",
      media_id: r.media_id || r.asset_id || r.id || null,
      is_base:  !!r.is_base,
      // 🔥 preserve DNA fields for optimizePrompt
      id:       r.media_id || r.id || null,
      label:    r.label    || null,
      type:     r.type     || "reference",
      dna:      r.dna      || null,
    }));
console.log("input_assets ************************** ", input_assets);
    // 2. Provider
    const provider = this._resolveProvider(model_name, { references: input_assets });

    // 3. Params
    const verified = verifyAndClampParams(provider, {
      steps, guidance_scale, ratio, quality, count: 1,
    });

    // ── NEW: Check Wallet Balance before DB writes ────────────────────────
    let holdAmount = 0;
    let pricingDetails = null;
    if (this.walletService && userId) {
      pricingDetails = calculateImageCredits({
        modelKey: model_name || "z_image",
        quality: verified.quality || "standard",
        count: 1,
        operation: "edit",
      });
      holdAmount = pricingDetails.credits;

      if (holdAmount > 0) {
        await this.walletService.checkSufficientFunds(userId, holdAmount);
      }
    }

    // 4. Size
    const sizeInfo = this._getStandardSize(verified.ratio, verified.quality);

    // 5. generation_type
    const generation_type = input_assets.length > 0 ? "TEXT_REFERENCES" : "TEXT_ONLY";

    // 6. Config
    const config = await this.db.configs.createConfig({
      prompt,
      model:        model_name,
      aspect_ratio: verified.ratio || "LANDSCAPE",
      generation_type,
    });

    await Promise.all(
      input_assets
        .filter((asset) => asset?.media_id)
        .map((asset, index) =>
          this.db.configs.createReference({
            generation_config_id: config.id,
            position:   index,
            input_type: asset.is_base
              ? "IMAGE_INPUT_TYPE_BASE_IMAGE"
              : "IMAGE_INPUT_TYPE_REFERENCE",
            ref_media_id: asset.media_id,
          })
        )
    );

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
        url:    null,
        width:  sizeInfo?.width  || 1024,
        height: sizeInfo?.height || 1024,
      },
      initialStatus: "processing",
    });

    return {
      userId,
      model_name,
      prompt,
      negative_prompt,
      generation_type,
      ratio:          verified.ratio,
      quality:        verified.quality,
      steps:          verified.steps,
      guidance_scale: verified.guidance_scale,
      size:           sizeInfo?.size,
      width:          sizeInfo?.width,
      height:         sizeInfo?.height,
      seed,
      input_assets,
      upscaleScale,
      configId:  config.id,
      workflow:  wf,
      mediaId:   media.id,
      // Pricing and wallet state
      walletHoldAmount: holdAmount,
      pricingDetails,
    };
  }

  // ─────────────────────────────────────────────────────────
  // 🔥 PROMPT OPTIMIZATION — dynamic pipeline
  //
  // CASES:
  //   1. No prompt          → skip everything
  //   2. Prompt + no refs   → simple safety + upscale (no DNA)
  //   3. Prompt + refs      → full processPrompt() pipeline
  //      a. refs avec DNA   → [EDIT CONTEXT] + [CHARACTER DNA] + optimize
  //      b. refs sans DNA   → [EDIT CONTEXT] + optimize
  // ─────────────────────────────────────────────────────────
  async optimizePrompt(task) {
    const { prompt, negative_prompt, quality, mediaId, input_assets, model_name } = task;

    // ── Case 1: No prompt — skip everything ───────────────────────────────
    if (!prompt?.trim()) {
      console.log(`[${this.constructor.name}] No prompt — skipping optimization`);
      return { finalPrompt: prompt || "", finalNegative: negative_prompt || "" };
    }

    // ── Case 2: No references — simple safety + upscale ───────────────────
    if (!input_assets?.length) {
      console.log(`[${this.constructor.name}] No references — simple optimization`);

      const safety = await this.promptService.checkPrompt(prompt);
      if (!safety.safe) {
        if (mediaId) await markMediaFailed(this.db, mediaId, safety.reason);
        throw new Error(`Prompt rejected: ${safety.reason}`);
      }

      try {
        const enhanced    = await this.promptService.upscalePrompt(prompt, { quality });
        const finalPrompt = enhanced?.optimized || enhanced?.enhanced || prompt;
        const autoNeg     = await this.promptService.generateNegativePrompt(finalPrompt);
        const finalNegative = [negative_prompt || "", autoNeg || ""].filter(Boolean).join(", ");
        return { finalPrompt, finalNegative };
      } catch (err) {
        console.error(`[${this.constructor.name}] Simple enhancement failed: ${err.message}`);
        return { finalPrompt: prompt, finalNegative: negative_prompt || "" };
      }
    }

    // ── Case 3: Prompt + references — full processPrompt() pipeline ────────
    console.log(`[${this.constructor.name}] Full pipeline — ${input_assets.length} refs, model: ${model_name}`);
    console.log(`[${this.constructor.name}] ALL REFERENCES INCOMING:`, JSON.stringify(input_assets, null, 2));

    const result = await processPrompt({
      prompt,
      references:   input_assets,   // carries url + label + type + dna + is_base
      modelType:    model_name,
      textProvider: this.promptService.textProvider,
      isEdit:       true,            // always edit mode in BaseEditTreatment
    });
    console.log("result ***************************** ", result);
    // Safety rejected
    if (!result.success) {
      if (mediaId) await markMediaFailed(this.db, mediaId, result.reason);
      throw new Error(`Prompt rejected: ${result.reason}`);
    }

    // Merge negative prompt
    let finalNegative = negative_prompt || "";
    try {
      const autoNeg = await this.promptService.generateNegativePrompt(result.prompt);
      finalNegative = [negative_prompt || "", autoNeg || ""].filter(Boolean).join(", ");
    } catch (_) {
      // negative prompt generation failed — use original
    }

    console.log(`[${this.constructor.name}] ✅ Final prompt ready`);

    return {
      finalPrompt:   result.prompt,
      finalNegative,
    };
  }

  // ─────────────────────────────────────────────────────────
  // 🔥 RUN JOB (Orchestrator)
  // ─────────────────────────────────────────────────────────
  async runJob(task) {
    try {
      const duplicateSkip = await skipIfMediaAlreadyDone(this.db, task.mediaId);
      if (duplicateSkip) {
        if (this.walletService && task.walletReferenceId) {
          await this.walletService.commitHoldIdempotent(task.walletReferenceId);
        }
        return duplicateSkip;
      }

      const optimized = await this.optimizePrompt(task);
      const result = await this.run({
        ...task,
        enhanced_prompt:   optimized.finalPrompt,
        enhanced_negative: optimized.finalNegative,
      });

      if (this.walletService && task.walletReferenceId) {
        await this.walletService.commitHoldIdempotent(task.walletReferenceId);
      }

      return result;
    } catch (error) {
      if (this.walletService && task.walletReferenceId) {
        try {
          await this.walletService.rollback(task.walletReferenceId);
        } catch (walletError) {
          console.error(`[${this.constructor.name}] wallet rollback failed for ${task.walletReferenceId}: ${walletError.message}`);
        }
      }
      throw error;
    }
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
      enhanced_prompt,
      enhanced_negative,
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

    let finalPrompt   = enhanced_prompt   !== undefined ? enhanced_prompt   : prompt;
    let finalNegative = enhanced_negative !== undefined ? enhanced_negative : negative_prompt;

    // Fallback — should not happen if worker pattern is followed
    if (enhanced_prompt === undefined) {
      const optimized = await this.optimizePrompt(task);
      finalPrompt   = optimized.finalPrompt;
      finalNegative = optimized.finalNegative;
    }

    const sourceAsset =
      input_assets.find(a => a.is_base || a.role === "source") ||
      input_assets[0];

    const image_url = sourceAsset?.url || null;

    const form = {
      prompt:          finalPrompt,
      negativePrompt:  finalNegative,
      negative_prompt: finalNegative,
      ratio, quality, size, width, height,
      steps:         steps          || 20,
      guidanceScale: guidance_scale || 7.5,
      seed,
      image:      image_url,
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
      url:    fileUrl,
      width:  result.width  || width  || 1024,
      height: result.height || height || 1024,
    });

    await markMediaStatus(this.db, mediaId, "success");

    return { configId, mediaId, workflowId: workflow.id };
  }

  // ─────────────────────────────────────────────────────────
  // 🔥 EXECUTE
  // ─────────────────────────────────────────────────────────
  async execute(input) {
    let task;
    try {
      task = await this.prepare(input);
    } catch (error) {
      throw error;
    }

    const userId = input?.userId || input?.user_id;
    const shouldHoldCredits =
      !!this.walletService &&
      !!userId &&
      !!task?.configId &&
      (task.walletHoldAmount > 0);

    let walletReferenceId = null;

    if (shouldHoldCredits) {
      walletReferenceId = task.configId;

      await this.walletService.hold({
        userId: userId,
        amount: task.walletHoldAmount,
        referenceId: walletReferenceId,
        metadata: {
          treatment:       this.getQueueType(),
          model_name:      task.model_name      || input?.model_name  || null,
          prompt:          task.prompt          || input?.prompt       || null,
          project_id:      task.project_id      || input?.project_id  || null,
          session_id:      task.session_id      || input?.session_id  || null,
          workflow_id:     task.workflow?.id    || input?.workflow_id  || null,
          pricingVersion:  task.pricingDetails?.pricingVersion,
          pricingBreakdown: task.pricingDetails?.breakdown,
        },
      });

      const wallet = await this.walletService.getWalletOrThrow(userId);
      task.remainingBalance = wallet.balance;
    }

    if (walletReferenceId) {
      task.walletReferenceId = walletReferenceId;
    }

    let job;
    try {
      job = await enqueueTreatmentJob(
        this.getQueueType(),
        task,
        walletReferenceId ? { jobId: walletReferenceId } : {}
      );
    } catch (error) {
      if (this.walletService && walletReferenceId) {
        try {
          await this.walletService.rollback(walletReferenceId);
        } catch (walletError) {
          console.error(`[${this.constructor.name}] wallet rollback after enqueue failure failed for ${walletReferenceId}: ${walletError.message}`);
        }
      }
      throw error;
    }

    return {
      jobId:     job.id,
      configId:  task.configId,
      workflows: [task.workflow],
      provider:  task.model_name,
      status:    "queued",
      balance:   task.remainingBalance ?? null,
    };
  }
}