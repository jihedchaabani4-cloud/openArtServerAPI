/**
 * BaseGenerateImageTreatment.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared foundation for all image-generation treatments.
 *
 * ARCHITECTURE — Three clearly separated responsibilities:
 *
 *   1. prepare(input)       [SYNC-FAST — called by controller]
 *      Validates params, creates DB placeholders (config + workflows + media),
 *      returns a plain JSON-serialisable task descriptor.
 *      → Controller responds to user immediately after this.
 *      → Task is enqueued in BullMQ.
 *
 *   2. optimizePrompt(task) [ASYNC — called by worker]
 *      Safety check → prompt enhancement → negative prompt generation.
 *      Returns { finalPrompt, finalNegative }.
 *      Subclasses override this to swap in LLM refinement (ElementSheet).
 *
 *   3. run(task)            [ASYNC — called by worker]
 *      Receives task + optimize result, calls AI provider, uploads to storage,
 *      updates DB to success/failed.
 *      Subclasses override this for custom generation logic.
 *
 * REMOVED vs original:
 *   • execute()  fire-and-forget — no longer needed (BullMQ handles this)
 *   • runJob()   redundant wrapper — worker calls optimizePrompt + run directly
 *   • _resolveProvider() inline fallback chain → providerStrategy.resolveProvider()
 *   • Duplicated buildPayload logic in child run() → _buildPayload() shared method
 *   • Double optimizePrompt() risk — run() no longer calls optimizePrompt internally;
 *     the worker always calls optimizePrompt first, then passes result to run().
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { getStandardSize, normalizeImageSizeForModel }              from "#utils/sizeUtils.js";
import { verifyAndClampParams }                                     from "../../utils/treatmentUtils.js";
import { resolveProvider, buildProviderPayload, extractOutputUrl }  from "./providerStrategy.js";
import { appendMediaToWorkflow, markMediaStatus, markMediaFailed }  from "#db/workflowMediaOps.js";
import { enqueueTreatmentJob }                                      from "#queue/treatmentJob.js";
import { calculateImageCredits }                                    from "#image/core/modelRouter.js";
import { skipIfAllMediaAlreadyDone }                                from "#utils/skipIfMediaAlreadyDone.js";

export class BaseGenerateImageTreatment {

  constructor({ promptService, models, storageService, db, walletService = null }) {
    this.promptService  = promptService;
    this.models         = models;
    this.storageService = storageService;
    this.db             = db;
    this.walletService  = walletService;
    this.imageHoldAmountPerAsset = Number(process.env.IMAGE_GENERATION_HOLD_AMOUNT || 10);
  }

  // ─────────────────────────────────────────────────────────
  // Internal logger  (swap for winston/pino without touching callers)
  // ─────────────────────────────────────────────────────────

  _log(level, msg, meta = {}) {
    const line = `[${this.constructor.name}] ${msg}`;
    if (level === "error") console.error(line, meta);
    else                   console.log  (line, meta);
  }

  // ─────────────────────────────────────────────────────────
  // Provider helpers (delegate to providerStrategy)
  // ─────────────────────────────────────────────────────────

  _resolveProvider(model_name, input_assets = []) {
    return resolveProvider({ model_name, input_assets, models: this.models });
  }

  _buildPayload(provider, form) {
    return buildProviderPayload(provider, form);
  }

  // ─────────────────────────────────────────────────────────
  // Size & display-name helpers
  // ─────────────────────────────────────────────────────────

  _getStandardSize(ratio, quality) {
    return getStandardSize(ratio, quality);
  }

  _buildDisplayName(prompt, workflow_type) {
    if (!prompt || typeof prompt !== "string") {
      return workflow_type === "ELEMENT_SHEET" ? "Element Sheet" : "Image Generation";
    }

    let name = prompt.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

    if (workflow_type === "ELEMENT_SHEET") {
      name = name
        .replace(/\b(character|element|sprite|asset|reference|turnaround|model)\s+sheet\b/gi, "")
        .replace(/\bsheet\b/gi, "")
        .replace(/\s+/g, " ")
        .replace(/^[,:;.\-\s]+|[,:;.\-\s]+$/g, "")
        .trim();
    }

    return (name || (workflow_type === "ELEMENT_SHEET" ? "Element Sheet" : "Image Generation"))
      .substring(0, 60);
  }

  getQueueType() {
    return this.constructor.name;
  }

  // ─────────────────────────────────────────────────────────
  // 1. PREPARE  ← controller calls this, responds to user immediately
  //
  // Subclasses MUST override prepare() to:
  //   • Shape their raw input (resolve references, pick defaults, …)
  //   • Then call _runPrepare() with normalised params
  //
  // _runPrepare() is the shared DB-writing core — do NOT override it.
  // ─────────────────────────────────────────────────────────

  /**
   * _runPrepare — shared DB-writing core used by every subclass prepare().
   *
   * Creates: generation_config → batch (if count>1) → workflows → media placeholders.
   * Returns a plain JSON-serialisable task descriptor (safe to enqueue in Redis).
   *
   * @param {object}  opts
   * @param {string}    opts.prompt
   * @param {string}   [opts.prompt_optimise]
   * @param {string}   [opts.display_name]
   * @param {string}   [opts.negative_prompt]
   * @param {string}    opts.model_name
   * @param {string}   [opts.workflow_type]     default "GENERATION"
   * @param {string}   [opts.ratio]
   * @param {string}   [opts.quality]
   * @param {number}   [opts.steps]
   * @param {number}   [opts.guidance_scale]
   * @param {number}   [opts.count]             default 1
   * @param {number}   [opts.seed]
   * @param {number}   [opts.strength]
   * @param {string}    opts.userId
   * @param {string}    opts.project_id
   * @param {string}   [opts.session_id]
   * @param {Array}    [opts.input_assets]      resolved {url, role}[] — safe for Redis
   * @param {string}   [opts.stepId]            default "GEN"
   * @param {object}   [opts.extraTaskFields]   anything the subclass needs in the task
   *                                            (e.g. sheetType, systemPrompt, …)
   * @returns {object} task  — JSON-serialisable, ready for jobQueue.add()
   */
  async _runPrepare({
    prompt,
    prompt_optimise  = null,
    display_name     = null,
    negative_prompt  = "",
    model_name,
    workflow_type    = "GENERATION",
    ratio,
    quality,
    steps,
    guidance_scale,
    count            = 1,
    seed,
    strength,
    userId,
    project_id,
    session_id,
    input_assets     = [],
    stepId           = "GEN",
    extraTaskFields  = {},   // ← subclasses pass sheet-specific data here
  }) {

    // ── 1. Provider check (fast fail before any DB writes) ────────────────
    this._resolveProvider(model_name, input_assets); // throws if invalid

    // ── 2. Validate & clamp generation params ─────────────────────────────
    const provider = this._resolveProvider(model_name, input_assets);
    const verified  = verifyAndClampParams(provider, { steps, guidance_scale, ratio, quality, count });

    // ── NEW: Check Wallet Balance before DB writes ────────────────────────
    let holdAmount = 0;
    let pricingDetails = null;
    if (this.walletService && userId) {
      pricingDetails = calculateImageCredits({
        modelKey: model_name || "z_image",
        quality: verified.quality || "standard",
        count: verified.count,
        operation: "generated",
      });
      holdAmount = pricingDetails.credits;

      if (holdAmount > 0) {
        await this.walletService.checkSufficientFunds(userId, holdAmount);
      }
    }

    // ── 3. Compute pixel dimensions ───────────────────────────────────────
    const rawSizeInfo = this._getStandardSize(verified.ratio, verified.quality);
    const sizeInfo = normalizeImageSizeForModel(model_name, rawSizeInfo);

    // ── 4. Generation type ────────────────────────────────────────────────
    const generation_type = input_assets.length > 0 ? "TEXT_REFERENCES" : "TEXT_ONLY";

    this._log("info",
      `prepare | type:${generation_type} | model:${model_name} | refs:${input_assets.length} | count:${verified.count}`
    );

    // ── 5. Generation config (master record) ──────────────────────────────
    const config = await this.db.configs.createConfig({
      prompt,
      prompt_optimise,
      model:           model_name,
      aspect_ratio:    verified.ratio || "LANDSCAPE",
      generation_type,
    });

    await Promise.all(
      (input_assets || [])
        .filter((asset) => asset?.media_id)
        .map((asset, index) =>
          this.db.configs.createReference({
            generation_config_id: config.id,
            position: index,
            input_type: asset.is_base ? "IMAGE_INPUT_TYPE_BASE_IMAGE" : "IMAGE_INPUT_TYPE_REFERENCE",
            ref_media_id: asset.media_id,
          })
        )
    );

    // ── 6. Batch (only when count > 1) ────────────────────────────────────
    let batch = null;
    if (verified.count > 1) {
      batch = await this.db.batches.createBatch({
        project_id,
        session_id,
        generation_config_id: config.id,
        variation_count:      verified.count,
      });
    }

    // ── 7. Workflows ──────────────────────────────────────────────────────
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

    // ── 8. Media placeholders ─────────────────────────────────────────────
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

    // ── 9. Return task descriptor (JSON-serialisable → safe for Redis) ────
    return {
      // Identity
      userId,
      project_id,
      session_id,
      // Model
      model_name,
      // Prompt (raw — optimization happens in worker)
      prompt,
      prompt_optimise,
      negative_prompt,
      // Generation params
      generation_type,
      ratio:          verified.ratio,
      quality:        verified.quality,
      steps:          verified.steps,
      guidance_scale: verified.guidance_scale,
      count:          verified.count,
      seed,
      strength,
      // Size
      size:    sizeInfo?.size   || null,
      width:   sizeInfo?.width  || null,
      height:  sizeInfo?.height || null,
      // Assets (URLs only — no circular refs)
      input_assets,
      // DB IDs
      configId:  config.id,
      batchId:   batch?.id || null,
      workflows,   // [{id, display_name, …}]
      mediaIds,
      // Pricing and wallet state
      walletHoldAmount: holdAmount,
      pricingDetails,
      // Subclass-specific extras (sheetType, systemPrompt, temperature, …)
      ...extraTaskFields,
    };
  }
  // Base implementation:  safety check → enhancement → negative prompt
  // Subclasses override to swap in LLM refinement (e.g. ElementSheet).
  //
  // CONTRACT: must return { finalPrompt: string, finalNegative: string }
  //           must mark media as failed and throw if prompt is rejected
  // ─────────────────────────────────────────────────────────

  async optimizePrompt(task) {
    const { prompt, prompt_optimise, negative_prompt, quality, mediaIds } = task;
    const rawPrompt = prompt_optimise || prompt;

    let finalPrompt   = rawPrompt;
    let finalNegative = negative_prompt || "";

    if (!rawPrompt) return { finalPrompt, finalNegative };

    // ── Safety check ──────────────────────────────────────────────────────
    const safety = await this.promptService.checkPrompt(rawPrompt);
    if (!safety.safe) {
      for (const id of mediaIds ?? []) {
        await markMediaFailed(this.db, id, safety.reason);
      }
      throw new Error(`Prompt rejected: ${safety.reason}`);
    }

    // ── Enhancement ───────────────────────────────────────────────────────
    try {
      const enhanced = await this.promptService.upscalePrompt(rawPrompt, { quality });
      finalPrompt    = enhanced.enhanced || rawPrompt;

      const autoNeg  = await this.promptService.generateNegativePrompt(finalPrompt);
      finalNegative  = [negative_prompt || "", autoNeg || ""].filter(Boolean).join(", ");
    } catch (err) {
      this._log("error", `Prompt enhancement failed (continuing with raw): ${err.message}`);
    }

    return { finalPrompt, finalNegative };
  }

  // ─────────────────────────────────────────────────────────
  // 3. RUN  ← worker calls this AFTER optimizePrompt
  //
  // Receives task + { finalPrompt, finalNegative } from the worker.
  // Dispatches one _runVariation() per workflow (parallel, allSettled).
  //
  // Worker pattern:
  //   const optimized = await treatment.optimizePrompt(task);
  //   const result    = await treatment.run(task, optimized);
  // ─────────────────────────────────────────────────────────

  /**
   * @param {object} task           — descriptor from prepare()
   * @param {object} optimizeResult — { finalPrompt, finalNegative } from optimizePrompt()
   */
  async run(task, optimizeResult) {
    const { model_name, input_assets, batchId, configId, workflows, mediaIds } = task;
    const { finalPrompt, finalNegative } = optimizeResult;

    const provider = this._resolveProvider(model_name, input_assets);

    const results = await Promise.allSettled(
      workflows.map((workflow, i) =>
        this._runVariation({
          ...task,
          provider,
          workflow,
          mediaId:       mediaIds[i],
          finalPrompt,
          finalNegative,
          variationIndex: i,
        })
      )
    );

    const succeeded = results.filter(r => r.status === "fulfilled").length;
    const failed    = results.filter(r => r.status === "rejected").length;

    if (succeeded === 0) {
      const firstErr = results.find(r => r.status === "rejected");
      throw new Error(firstErr?.reason?.message || "All variations failed");
    }

    this._log("info", `run complete | configId:${configId} | ok:${succeeded} fail:${failed}`);
    return { batchId, configId, succeeded, failed };
  }

  // ─────────────────────────────────────────────────────────
  // _runVariation  — one image: generate → upload → DB update
  //
  // Subclasses can override for custom single-image logic.
  // ─────────────────────────────────────────────────────────

  async _runVariation({
    provider, workflow, mediaId,
    userId, model_name,
    prompt, finalPrompt, finalNegative,
    ratio, quality, size, width, height,
    steps, guidance_scale, seed, strength,
    input_assets,
    configId, variationIndex,
  }) {
    try {
      const sourceAsset = input_assets?.find(
        a => ["source", "normal", "start", "base"].includes(a.role)
      ) ?? input_assets?.[0];

      const form = {
        prompt:          finalPrompt,
        negativePrompt:  finalNegative,
        negative_prompt: finalNegative,
        ratio, quality, size, width, height,
        steps:           steps          ?? 20,
        guidanceScale:   guidance_scale ?? 7.5,
        guidance_scale:  guidance_scale ?? 7.5,
        seed,
        strength:        strength ?? 0.8,
        image:           sourceAsset?.url ?? null,
        image_url:       sourceAsset?.url ?? null,
        references:      input_assets,
        index:           variationIndex,
      };

      const payload   = this._buildPayload(provider, form);
      const result    = await provider.generate(payload);
      const outputUrl = extractOutputUrl(result);

      const fileName  = `${userId}/generations/${workflow.id}_${Date.now()}.png`;
      const fileUrl   = await this.storageService.uploadFromUrl(fileName, outputUrl);

      // Per-variation config stores the actual seed used by the provider
      const mediaConfig = await this.db.configs.createConfig({
        prompt,
        model:           model_name,
        aspect_ratio:    ratio || "LANDSCAPE",
        generation_type: (input_assets?.length ?? 0) > 0 ? "TEXT_REFERENCES" : "TEXT_ONLY",
        seed:            result.seed ?? seed ?? null,
      });

      await Promise.all(
        (input_assets || [])
          .filter((asset) => asset?.media_id)
          .map((asset, index) =>
            this.db.configs.createReference({
              generation_config_id: mediaConfig.id,
              position: index,
              input_type: asset.is_base ? "IMAGE_INPUT_TYPE_BASE_IMAGE" : "IMAGE_INPUT_TYPE_REFERENCE",
              ref_media_id: asset.media_id,
            })
          )
      );

      await this.db.media.updateFields(mediaId, {
        generation_config_id: mediaConfig.id,
        url:    fileUrl,
        width:  result.width  ?? width  ?? 1024,
        height: result.height ?? height ?? 1024,
      });
      await markMediaStatus(this.db, mediaId, "success");

      return { fileUrl, mediaId, workflowId: workflow.id };

    } catch (err) {
      await markMediaFailed(this.db, mediaId, err);
      throw err;
    }
  }

  async runJob(task) {
    try {
      const duplicateSkip = await skipIfAllMediaAlreadyDone(this.db, task.mediaIds);
      if (duplicateSkip) {
        if (this.walletService && task.walletReferenceId) {
          await this.walletService.commitHoldIdempotent(task.walletReferenceId);
        }
        return {
          batchId: task.batchId ?? null,
          configId: task.configId,
          ...duplicateSkip,
        };
      }

      const optimized = await this.optimizePrompt(task);
      const result = await this.run(task, optimized);

      if (this.walletService && task.walletReferenceId) {
        await this.walletService.commitHoldIdempotent(task.walletReferenceId);
      }

      return result;
    } catch (error) {
      if (this.walletService && task.walletReferenceId) {
        try {
          await this.walletService.rollback(task.walletReferenceId);
        } catch (walletError) {
          this._log("error", `wallet rollback failed for ${task.walletReferenceId}: ${walletError.message}`);
        }
      }

      throw error;
    }
  }

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
      this._log("info", `holding credits for user:${userId} | configId:${task.configId}`);
      walletReferenceId = task.configId;

      await this.walletService.hold({
        userId: userId,
        amount: task.walletHoldAmount,
        referenceId: walletReferenceId,
        metadata: {
          treatment: this.getQueueType(),
          model_name: task.model_name || input?.model_name || null,
          prompt: task.prompt || input?.prompt || null,
          count: task.count,
          project_id: task.project_id || input?.project_id || null,
          session_id: task.session_id || input?.session_id || null,
          pricingVersion: task.pricingDetails?.pricingVersion,
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
          this._log("error", `wallet rollback after enqueue failure failed for ${walletReferenceId}: ${walletError.message}`);
        }
      }
      throw error;
    }

    return {
      jobId: job.id,
      status: "queued",
      batchId: task.batchId ?? null,
      configId: task.configId ?? null,
      workflows: task.workflows ?? [],
      provider: task.model_name ?? null,
      balance: task.remainingBalance ?? null,
    };
  }
}
