import { getRunner, getModelName             } from "#video/core/modelRouter.js";
import { calculateVideoCredits               } from "#video/core/modelRouter.js";
import { appendMediaToWorkflow, markMediaStatus, markMediaFailed } from "#db/workflowMediaOps.js";
import { verifyAndClampVideoParams              } from "#image/utils/treatmentUtils.js";
import { ReferenceProcessor                     } from "#utils/ReferenceProcessor.js";
import { getStandardSize                        } from "#utils/sizeUtils.js";
import { enqueueTreatmentJob }                  from "#queue/treatmentJob.js";
import { processVideoPrompt }                   from "#services/promptServiceV2.js";
import { skipIfMediaAlreadyDone }               from "#utils/skipIfMediaAlreadyDone.js";

// ─── Mode Builders ────────────────────────────────────────────────────────────

function buildCommon(input) {
    return {
        model:             input.model,
        ratio:             input.clampedRatio,
        duration:          input.clampedDuration,
        cfgScale:          input.clampedCfg,
        resolution:        input.video_resolution,
        negativePrompt:    input.negativePrompt,
        multiPrompt:       input.multiPrompt,
        sound:             input.sound,
        keepOriginalSound: input.keepOriginalSound,
        cameraControl:     input.cameraControl ?? input.camera_control,
    };
}

function buildT2V({ prompt, common }) {
    return { ...common, prompt };
}

function buildI2V({ prompt, startAsset, common }) {
    if (!startAsset?.url) throw new Error("[i2v] startAsset.url is required");
    return { ...common, prompt, image: startAsset.url };
}

function buildI2V_SE({ prompt, startAsset, endAsset, common }) {
    if (!startAsset?.url) throw new Error("[i2v_se] startAsset.url is required");
    if (!endAsset?.url)   throw new Error("[i2v_se] endAsset.url is required");
    return { ...common, prompt, image: startAsset.url, end_image: endAsset.url };
}

function buildR2V({ prompt, referenceAssets, common }) {
    if (!referenceAssets?.length) throw new Error("[r2v] At least one reference asset is required");
    return { ...common, prompt, references: referenceAssets };
}

function buildMotion({ prompt, startAsset, common }) {
    if (!startAsset?.url) throw new Error("[motion] startAsset.url is required");
    return { ...common, prompt, image: startAsset.url };
}

function buildV2V({ prompt, startAsset, common }) {
    if (!startAsset?.url) throw new Error("[v2v] source video URL is required");
    return { ...common, prompt, video: startAsset.url };
}

const MODE_BUILDERS = {
    t2v:    buildT2V,
    i2v:    buildI2V,
    i2v_se: buildI2V_SE,
    r2v:    buildR2V,
    motion: buildMotion,
    v2v:    buildV2V,
};

// ─── Constants ────────────────────────────────────────────────────────────────

const ROLE_ALIASES = new Set(["start", "source", "normal", "base"]);

const PROVIDER_METHODS = {
    t2v:    (p, payload, mode) => p.generate(payload, mode),
    i2v:    (p, payload, mode) => p.generate(payload, mode),
    i2v_se: (p, payload, mode) => p.generate(payload, mode),
    motion: (p, payload, mode) => p.generate(payload, mode),
    r2v:    (p, payload, mode) => p.generate(payload, mode),
    v2v:    (p, payload, mode) => p.generate(payload, mode),
};

const DB_INPUT_TYPE = {
    start: "IMAGE_INPUT_TYPE_START_FRAME",
    end:   "IMAGE_INPUT_TYPE_END_FRAME",
    other: "IMAGE_INPUT_TYPE_REFERENCE",
};

const GENERATION_TYPE = {
    i2v_se: "TEXT_START_END_FRAMES",
    i2v:    "TEXT_BASE_IMAGE",
    r2v:    "TEXT_REFERENCES",
    motion: "TEXT_BASE_IMAGE",
    v2v:    "TEXT_BASE_IMAGE",
    t2v:    "TEXT_ONLY",
};

// ─── Validation ───────────────────────────────────────────────────────────────

function validateInput(input) {
    const errors = [];
    const userId = input.userId || input.user_id;

    if (!userId)          errors.push("userId is required");
    if (!input.project_id) errors.push("project_id is required");
    if (!input.session_id) errors.push("session_id is required");

    if (errors.length) throw new Error(`[VideoTreatment] ${errors.join(" | ")}`);
    return userId;
}

function validateProvider(model, mode) {
    const provider = getRunner(model, mode);
    if (!provider) throw new Error(
        `[VideoTreatment] Model "${model}" does not support mode "${mode}".`
    );
    return provider;
}

// ─── Asset Helpers ────────────────────────────────────────────────────────────

function categorizeAssets(input_assets) {
    const startAsset      = input_assets.find(a => ROLE_ALIASES.has(a.role));
    const endAsset        = input_assets.find(a => a.role === "end");
    const referenceAssets = input_assets.filter(a => a !== startAsset && a !== endAsset);
    return { startAsset, endAsset, referenceAssets };
}

function resolveMode(startAsset, endAsset, referenceAssets) {
    if (startAsset && endAsset)     return "i2v_se";
    if (startAsset)                 return "i2v";
    if (referenceAssets.length > 0) return "r2v";
    return "t2v";
}

function normalizeReferences(rawReferences, image_workflow_id, reference_media_ids) {
    const refs = [...rawReferences];
    const existingMediaIds = new Set(refs.map(r => r.media_id || r.id).filter(Boolean));

    // Backward compatibility for image_workflow_id
    if (image_workflow_id && !existingMediaIds.has(image_workflow_id)) {
        refs.push({ workflow_id: image_workflow_id, role: "start" });
    }

    for (const mId of reference_media_ids) {
        const id = typeof mId === "string" ? mId : (mId.media_id || mId.id);
        if (id && !existingMediaIds.has(id)) {
            refs.push(typeof mId === "string" ? { media_id: mId, role: "reference" } : mId);
            existingMediaIds.add(id);
        }
    }
    return refs.filter(r => r?.workflow_id || r?.media_id || r?.url);
}

// ─── VideoTreatment ───────────────────────────────────────────────────────────

export class VideoTreatment {
    constructor({ promptService, storageService, db, walletService = null }) {
        this.promptService  = promptService;
        this.storageService = storageService;
        this.db             = db;
        this.walletService  = walletService;
        this.refProcessor   = new ReferenceProcessor({ storageService, db });
    }

    getQueueType() {
        return this.constructor.name;
    }

    // ── prepare ──────────────────────────────────────────────────────────────
    async prepare(input) {
        const {
            model                  = "kling_v3",
            prompt                 = "",
            ratio                  = "16:9",
            duration               = "5s",
            project_id,
            session_id,
            image_workflow_id,
            reference_media_ids = [],
            references: rawReferences = [],
            sound,
            cfgScale,
            negativePrompt         = "",
            multiPrompt,
            keepOriginalSound,
            video_resolution,
            camera_control,
            cameraControl,
        } = input;

        // 1. Validate
        const userId = validateInput(input);

        // 1b. Credit check (fail-fast before any DB writes)
        const durationSeconds = parseFloat(String(duration).replace("s", "")) || 5;
        let pricingDetails = null;
        let holdAmount = 0;
        if (this.walletService) {
            try {
                const priceResult = calculateVideoCredits({
                    modelKey: model,
                    durationSeconds,
                    resolution: video_resolution || "720p",
                    count: 1,
                });
                pricingDetails = priceResult;
                holdAmount = priceResult.credits;
                const wallet = await this.walletService.getWalletOrThrow(userId);
                if (wallet.balance < holdAmount) {
                    const { WalletError } = await import("#services/WalletService.js");
                    throw new WalletError(
                        `Insufficient funds: need ${holdAmount}, have ${wallet.balance}`,
                        "INSUFFICIENT_FUNDS"
                    );
                }
            } catch (err) {
                if (err.name === "WalletError") throw err;
                console.warn("[VideoTreatment] Credit check skipped:", err.message);
            }
        }

        // 2. Resolve all references into assets
        const toProcess    = normalizeReferences(rawReferences, image_workflow_id, reference_media_ids);
        const input_assets = await this.refProcessor.process(
            toProcess, userId, project_id, session_id, "uploads"
        );

        // 3. Categorize + detect mode
        const { startAsset, endAsset, referenceAssets } = categorizeAssets(input_assets);

        if (endAsset && !startAsset) throw new Error(
            "[VideoTreatment] End frame requires a start frame for keyframe interpolation."
        );

        const mode = resolveMode(startAsset, endAsset, referenceAssets);

        // 4. Validate provider supports this mode
        const provider = validateProvider(model, mode);

        // 5. Clamp generation params
        const { ratio: clampedRatio, duration: clampedDuration, cfgScale: clampedCfg }
            = verifyAndClampVideoParams(provider, { ratio, duration, cfgScale });

        // 6. Build mode-specific form
        //    Each builder owns what fields it needs — no shared if/else
        const builder = MODE_BUILDERS[mode];
        if (!builder) throw new Error(`[VideoTreatment] No builder registered for mode "${mode}".`);

        const form = builder({
            prompt,
            startAsset,
            endAsset,
            referenceAssets,
            common: buildCommon({
                model, clampedRatio, clampedDuration, clampedCfg,
                video_resolution, negativePrompt, multiPrompt,
                sound, keepOriginalSound, cameraControl, camera_control,
            }),
        });

        const model_name      = getModelName(model, mode);
        const generation_type = GENERATION_TYPE[mode] ?? "TEXT_ONLY";

        // 7. Persist config + references
        const config = await this.db.configs.createConfig({
            prompt, model: model_name, aspect_ratio: ratio, generation_type,
        });

        await Promise.all(
            input_assets
                .filter(a => a.media_id)
                .map((asset, i) => this.db.configs.createReference({
                    generation_config_id: config.id,
                    position:    i,
                    input_type:  asset === startAsset ? DB_INPUT_TYPE.start
                               : asset === endAsset   ? DB_INPUT_TYPE.end
                               :                        DB_INPUT_TYPE.other,
                    ref_media_id: asset.media_id,
                }))
        );

        // 8. Create workflow + placeholder media
        const { width, height } = getStandardSize(ratio, "1K");

        const workflow = await this.db.workflows.createWorkflow({
            project_id, session_id,
            display_name: prompt.substring(0, 60) || "Video Generation",
        });

        const media = await appendMediaToWorkflow(this.db, {
            workflow_id: workflow.id,
            mediaData:   { project_id, generation_config_id: config.id, step_id: "VID", width, height },
            initialStatus: "processing",
        });

        return {
            userId, project_id, session_id,
            model, model_name, mode, form,
            width, height,
            configId:   config.id,
            mediaId:    media.id,
            workflow,
            workflows:  [workflow],
            references: input_assets,
            walletHoldAmount: holdAmount,
            pricingDetails,
        };
    }

    // ── run ───────────────────────────────────────────────────────────────────
    async optimizePrompt(task) {
        const { form, mediaId, references = [], model_name, mode: videoMode } = task;
        const rawPrompt = form?.prompt || "";
        const baseNegative = form?.negativePrompt || "";

        if (!rawPrompt.trim()) {
            return { finalPrompt: rawPrompt, finalNegative: baseNegative };
        }

        const result = await processVideoPrompt({
            prompt: rawPrompt,
            references,
            modelType: model_name,
            textProvider: this.promptService.textProvider,
            videoMode,
        });

        if (!result.success) {
            await markMediaFailed(this.db, mediaId, result.reason);
            throw new Error(`Prompt rejected: ${result.reason}`);
        }

        // Single LLM round-trip: processVideoPrompt already does safety + optimization.
        // Do not call generateNegativePrompt here — it doubled text-model calls per video job.
        return { finalPrompt: result.prompt, finalNegative: baseNegative };
    }

    async run(task, optimizeResult = null) {
        const { model, form, mode, workflow, mediaId, userId, model_name, references } = task;
        const provider = validateProvider(model, mode);

        try {
            const optimized = optimizeResult || await this.optimizePrompt(task);
            const effectiveForm = {
                ...form,
                prompt: optimized.finalPrompt,
                negativePrompt: optimized.finalNegative,
            };

            const payload  = provider.toPayload(provider.adapt(effectiveForm, mode), mode);
            const execute  = PROVIDER_METHODS[mode];
            if (!execute) throw new Error(`[VideoTreatment] No execution method for mode "${mode}"`);

            const result   = await execute(provider, payload, mode);
            const outputUrl = result.video_url ?? result.image_url;
            if (!outputUrl) throw new Error(`Provider returned no URL for mode "${mode}"`);

            const fileName = `${userId}/videos/${workflow.id}_${Date.now()}.mp4`;
            const fileUrl  = await this.storageService.uploadFromUrl(fileName, outputUrl);

            const mediaConfig = await this.db.configs.createConfig({
                prompt:          effectiveForm.prompt,
                model:           model_name,
                aspect_ratio:    effectiveForm.ratio,
                generation_type: references.length > 0 ? "TEXT_REFERENCES" : "TEXT_ONLY",
                seed:            result.seed ?? null,
            });

            await Promise.all(
                (references || [])
                    .filter((asset) => asset?.media_id)
                    .map((asset, index) => this.db.configs.createReference({
                        generation_config_id: mediaConfig.id,
                        position: index,
                        input_type: asset.role === "start" ? DB_INPUT_TYPE.start
                                   : asset.role === "end" ? DB_INPUT_TYPE.end
                                   : DB_INPUT_TYPE.other,
                        ref_media_id: asset.media_id,
                    }))
            );

            await this.db.media.updateFields(mediaId, {
                generation_config_id: mediaConfig.id,
                url:    fileUrl,
                width:  result.width  ?? 1280,
                height: result.height ?? 720,
            });

            await markMediaStatus(this.db, mediaId, "success");
            return { fileUrl, mediaId };

        } catch (error) {
            await markMediaFailed(this.db, mediaId, error);
            throw error;
        }
    }

    async runJob(task) {
        try {
            const duplicateSkip = await skipIfMediaAlreadyDone(this.db, task.mediaId);
            if (duplicateSkip) {
                console.log(`[VideoTreatment] Skipping duplicate job — media ${task.mediaId} already completed (no extra provider charge)`);
                if (this.walletService && task.walletReferenceId) {
                    await this.walletService.commitHoldIdempotent(task.walletReferenceId);
                }
                return duplicateSkip;
            }

            const optimized = await this.optimizePrompt(task);
            const result = await this.run(task, optimized);

            if (this.walletService && task.walletReferenceId) {
                await this.walletService.commitHoldIdempotent(task.walletReferenceId);
            }

            return result;
        } catch (error) {
            if (this.walletService && task.walletReferenceId) {
                try { await this.walletService.rollback(task.walletReferenceId); } catch (e) {
                    console.error(`[VideoTreatment] wallet rollback failed: ${e.message}`);
                }
            }
            throw error;
        }
    }

    // ── execute ───────────────────────────────────────────────────────────────
    async execute(input) {
        const task = await this.prepare(input);

        const userId = input?.userId || input?.user_id;
        let walletReferenceId = null;

        if (this.walletService && userId && task.configId && task.walletHoldAmount > 0) {
            walletReferenceId = task.configId;
            
            await this.walletService.hold({
                userId,
                amount: task.walletHoldAmount,
                referenceId: walletReferenceId,
                metadata: {
                    treatment: this.getQueueType(),
                    model_name: task.model_name || null,
                    prompt: task.form?.prompt || null,
                    project_id: task.project_id || null,
                    session_id: task.session_id || null,
                    pricingVersion: task.pricingDetails?.pricingVersion,
                    pricingBreakdown: task.pricingDetails?.breakdown,
                },
            });

            const wallet = await this.walletService.getWalletOrThrow(userId);
            task.remainingBalance = wallet.balance;
        }

        if (walletReferenceId) task.walletReferenceId = walletReferenceId;

        let job;
        try {
            job = await enqueueTreatmentJob(
                this.getQueueType(),
                task,
                walletReferenceId ? { jobId: walletReferenceId } : {}
            );
        } catch (error) {
            if (this.walletService && walletReferenceId) {
                try { await this.walletService.rollback(walletReferenceId); } catch (e) {
                    console.error(`[VideoTreatment] wallet rollback failed: ${e.message}`);
                }
            }
            throw error;
        }

        return {
            jobId: job.id,
            batchId: task.batchId ?? null,
            configId: task.configId,
            workflows: task.workflows,
            status: "queued",
            mode: task.mode,
            model: task.model_name,
            balance: task.remainingBalance ?? null,
        };
    }
}
