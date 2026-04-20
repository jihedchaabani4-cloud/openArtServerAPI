import { ReferenceProcessor             } from "#utils/ReferenceProcessor.js";
import { getStandardSize               } from "#utils/sizeUtils.js";
import { getImageModel, ROUTED_IMAGE_MODELS } from "#image/core/modelRouter.js";
import { verifyAndClampParams          } from "../utils/treatmentUtils.js";
import { appendMediaToWorkflow, markMediaStatus } from "#db/workflowMediaOps.js";

/**
 * GenerateImageTreatment
 *
 * Architecture:
 *   prepare() → validates input, resolves provider, creates DB records
 *               returns plain JSON-serializable descriptor — safe for Redis
 *
 *   run(task) → receives descriptor, calls provider API per variation,
 *               uploads to storage, finalises DB records
 *
 *   execute() → legacy entry-point (prepare + run in background, no queue)
 */
export class GenerateImageTreatment {
    constructor({ promptService, models, storageService, db }) {
        this.promptService  = promptService;
        this.models         = models;
        this.storageService = storageService;
        this.db             = db;
        this.refProcessor   = new ReferenceProcessor({ storageService, db });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // HELPERS
    // ─────────────────────────────────────────────────────────────────────────

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

    _resolveProvider(model_name, input) {
        const { image_base64, references = [], edit_type } = input;

        const route      = getImageModel(model_name);
        const modelGroup = route?.group || this.models[model_name];

        if (!modelGroup && !route) {
            throw new Error(
                `Model "${model_name}" not found. Available: ${ROUTED_IMAGE_MODELS.join(", ")}`
            );
        }

        const hasBase  = !!image_base64;
        const hasRefs  = references.length > 0 || hasBase;
        const isMulti  = references.length > 1;
        const variantKey = hasRefs ? (isMulti ? "i2iMulti" : "i2i") : "t2i";

        let provider;
        if (route && route[variantKey])              provider = route[variantKey];
        else if (route && route["i2i"] && hasRefs)   provider = route["i2i"];
        else if (route && route["t2i"])              provider = route["t2i"];
        else if (modelGroup?.resolve)                provider = modelGroup.resolve({ references, image_base64, edit_type });
        else if (modelGroup)                         provider = modelGroup[variantKey] || (hasRefs ? modelGroup.i2i : null) || modelGroup.t2i || modelGroup;
        else                                         provider = modelGroup;

        if (!["t2i", "i2i"].includes(provider.type)) {
            throw new Error(`Model "${model_name}" is a video model. Use VideoTreatment instead.`);
        }

        return provider;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. PREPARE
    //    • Validates all inputs
    //    • Resolves model + provider (stored as string, re-resolved in run())
    //    • Processes references (uploads if needed)
    //    • Creates generation_config + batch + workflows in DB
    //    • Returns plain JSON-serializable descriptor — safe for Redis
    // ─────────────────────────────────────────────────────────────────────────

    async prepare(input) {
        const {
            prompt,
            prompt_optimise       = null,
            display_name          = null,
            negative_prompt       = "",
            model_name            = "nanobana",
            workflow_type         = "GENERATION",
            image_base64          = null,
            strength,
            seed,
            project_id,
            session_id,
        } = input;

        const userId = input.userId || input.user_id;
        if (!userId)     throw new Error("userId required");
        if (!project_id) throw new Error("project_id required");

        let { ratio, quality, steps, guidance_scale, count = 1 } = input;

        const generation_prompt = prompt_optimise || prompt;

        // 1a. Resolve provider
        const provider = this._resolveProvider(model_name, input);

        // 1b. Verify & clamp params
        const verified = verifyAndClampParams(provider, {
            steps, guidance_scale, ratio, quality, count,
        });
        steps          = verified.steps;
        guidance_scale = verified.guidance_scale;
        ratio          = verified.ratio;
        quality        = verified.quality;
        count          = verified.count;

        // 1c. Process references
        const rawRefs    = input.references || [];
        const input_assets = await this.refProcessor.process(
            rawRefs, userId, project_id, session_id, "uploads"
        );

        // 1d. Resolve size
        const sizeInfo = this._getStandardSize(ratio, quality);
        const size     = sizeInfo?.size   || null;
        const width    = sizeInfo?.width  || null;
        const height   = sizeInfo?.height || null;

        // 1e. Determine generation type
        const hasActualBase = !!image_base64;
        const hasActualRefs = input_assets.length > 0;

        let generation_type = "TEXT_ONLY";
        if (hasActualRefs && hasActualBase)  generation_type = "TEXT_BASE_IMAGE_REFERENCES";
        else if (hasActualRefs)              generation_type = "TEXT_REFERENCES";
        else if (hasActualBase)              generation_type = "TEXT_BASE_IMAGE";

        console.log(
            `[ImageTreatment] prepare | type:${generation_type} | ` +
            `refs:${input_assets.length} | base:${hasActualBase} | count:${count}`
        );

        // 1f. Create generation_config (batch-level)
        const config = await this.db.configs.createConfig({
            prompt,
            prompt_optimise,
            model:           model_name,
            aspect_ratio:    ratio || "LANDSCAPE",
            generation_type,
        });

        // 1g. Attach references to config
        for (let i = 0; i < input_assets.length; i++) {
            const asset = input_assets[i];
            if (asset.media_id) {
                await this.db.configs.createReference({
                    generation_config_id: config.id,
                    position:   i,
                    input_type: asset.is_base
                        ? "IMAGE_INPUT_TYPE_BASE_IMAGE"
                        : "IMAGE_INPUT_TYPE_REFERENCE",
                    ref_media_id: asset.media_id,
                });
            }
        }

        // 1h. Create batch (only when count > 1)
        let batch = null;
        if (count > 1) {
            batch = await this.db.batches.createBatch({
                project_id,
                session_id,
                generation_config_id: config.id,
                variation_count:      count,
            });
        }

        // 1i. Create one workflow per variation
        const displayName = display_name || this._buildDisplayName(prompt, workflow_type);
        const workflows   = [];

        for (let i = 0; i < count; i++) {
            const wf = await this.db.workflows.createWorkflow({
                project_id,
                session_id,
                batch_id:        batch?.id || null,
                display_name:    displayName,
                variation_index: i,
                workflow_type,
            });
            workflows.push(wf);
        }

        // 1j. Create placeholder media rows (one per workflow)
        const mediaIds = [];
        for (const wf of workflows) {
            const media = await appendMediaToWorkflow(this.db, {
                workflow_id: wf.id,
                mediaData: {
                    project_id,
                    generation_config_id: config.id,
                    step_id: "CAE",
                    url:     null,
                    width:   width  || 1024,
                    height:  height || 1024,
                },
                initialStatus: "processing",
            });
            mediaIds.push(media.id);
        }

        // Safety check — reject bad prompts before queuing
        const promptForGeneration = prompt_optimise || prompt;
        if (promptForGeneration) {
            const safety = await this.promptService.checkPrompt(promptForGeneration);
            if (!safety.safe) {
                // Mark all placeholder media as failed
                for (const id of mediaIds) {
                    await markMediaStatus(this.db, id, "failed", safety.reason);
                }
                throw new Error(`Prompt rejected: ${safety.reason}`);
            }
        }

        // Return plain JSON-serializable descriptor
        return {
            // identifiers
            userId,
            project_id,
            session_id,
            // model — string only (provider re-resolved in run())
            model_name,
            // generation params
            prompt,
            prompt_optimise,
            generation_prompt,
            negative_prompt,
            generation_type,
            ratio,
            quality,
            size,
            width,
            height,
            steps,
            guidance_scale,
            seed,
            strength,
            count,
            // assets
            input_assets,
            image_base64,
            mask_selection: input.mask_selection || null,
            // DB references
            configId:  config.id,
            batchId:   batch?.id || null,
            workflows,
            mediaIds,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. RUN
    //    Receives the descriptor from prepare() (via Redis → Scheduler).
    //    Runs one API call per variation, uploads results, finalises DB.
    // ─────────────────────────────────────────────────────────────────────────

    async run(task) {
        const {
            userId, project_id,
            model_name,
            prompt, generation_prompt, negative_prompt,
            generation_type,
            ratio, quality, size, width, height,
            steps, guidance_scale, seed, strength,
            input_assets, image_base64, mask_selection,
            configId, batchId,
            workflows, mediaIds,
        } = task;

        // Re-resolve provider (not serializable — resolved fresh each run)
        const provider = this._resolveProvider(model_name, {
            image_base64,
            references: input_assets,
        });

        // 2a. Prompt Enhancement (Upscale + Negative) — Match legacy quality
        const promptForGeneration = generation_prompt || prompt;
        let finalPrompt   = promptForGeneration;
        let finalNegative = negative_prompt;

        try {
            console.log(`[ImageTreatment] Enhancing prompt for quality: ${quality}...`);
            const enhanced = await this.promptService.upscalePrompt(promptForGeneration, { quality });
            finalPrompt    = enhanced.enhanced;
            
            const autoNeg  = await this.promptService.generateNegativePrompt(finalPrompt);
            finalNegative  = [negative_prompt || "", autoNeg || ""].filter(Boolean).join(", ");
            
            console.log(`[ImageTreatment] Enhanced Prompt: "${finalPrompt.substring(0, 50)}..."`);
        } catch (err) {
            console.error(`[ImageTreatment] Prompt enhancement failed (continuing with raw): ${err.message}`);
        }

        // 2c. Run one generation per variation
        const results = await Promise.allSettled(
            workflows.map((workflow, i) =>
                this._runVariation({
                    provider,
                    workflow,
                    mediaId: mediaIds[i],
                    userId,
                    project_id,
                    model_name,
                    prompt, 
                    enhanced_prompt:  finalPrompt,
                    enhanced_negative: finalNegative,
                    generation_type,
                    ratio, quality, size, width, height,
                    steps, guidance_scale, seed, strength,
                    input_assets,
                    image_base64,
                    mask_selection,
                    configId,
                    variationIndex: i,
                })
            )
        );

        const succeeded = results.filter(r => r.status === "fulfilled").length;
        const failed    = results.filter(r => r.status === "rejected").length;

        console.log(
            `[ImageTreatment] run done | ` +
            `batch:${batchId ?? "none"} | ok:${succeeded} fail:${failed}`
        );

        if (succeeded === 0) {
            const firstErr = results.find(r => r.status === "rejected");
            throw new Error(firstErr?.reason?.message || "All variations failed");
        }

        return { batchId, configId, succeeded, failed };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // RUN VARIATION  (one image generation)
    // ─────────────────────────────────────────────────────────────────────────

    async _runVariation({
        provider, workflow, mediaId,
        userId, project_id, model_name,
        prompt, enhanced_prompt, enhanced_negative,
        generation_type, ratio, quality,
        size, width, height,
        steps, guidance_scale, seed, strength,
        input_assets, image_base64, mask_selection,
        configId, variationIndex,
    }) {
        try {
            // Resolve core assets (source image, mask) for legacy builders
            const sourceAsset = (input_assets || []).find(a => ["source", "normal", "start", "base"].includes(a.role));
            const maskAsset   = (input_assets || []).find(a => a.role === "mask");
            const image_url   = sourceAsset?.url || image_base64 || null;
            const mask_url    = maskAsset?.url   || null;

            const form = {
                prompt:          enhanced_prompt,
                negativePrompt:  enhanced_negative,
                negative_prompt: enhanced_negative,
                ratio, quality, size, width, height,
                steps:           steps || 20,
                guidanceScale:   guidance_scale || 7.5,
                guidance_scale:  guidance_scale || 7.5,
                seed, 
                strength:        strength || 0.8,
                image:           image_url,
                image_url:       image_url, 
                mask:            mask_url,
                mask_url:        mask_url,
                mask_selection,
                references:      input_assets,
                index:           variationIndex,
            };

            // Build payload using either Modern or Legacy pattern
            let payload;
            if (typeof provider.buildPayload === "function") {
                payload = provider.buildPayload(form);
            } else if (typeof provider.adapt === "function") {
                // Legacy pattern used in apiOpenArt adapters (Replicate, Fal, etc.)
                const adapted = provider.adapt(form);
                payload = provider.toPayload ? provider.toPayload(adapted) : adapted;
            } else {
                // Raw fallback
                payload = form;
            }

            console.log(
                `[ImageTreatment] variation:${variationIndex} | ` +
                `workflow:${workflow.id} | calling provider (${provider.constructor.name})...`
            );

            // Call provider API
            const result = await provider.generate(payload);

            const outputUrl = result.image_url || result.url;
            if (!outputUrl) {
                throw new Error("Provider returned no output URL");
            }

            // Upload to storage
            const ext      = "png";
            const fileName = `${userId}/generations/${workflow.id}_${Date.now()}.${ext}`;
            const fileUrl  = await this.storageService.uploadFromUrl(fileName, outputUrl);

            // Create per-media generation_config (with seed)
            const mediaConfig = await this.db.configs.createConfig({
                prompt,
                prompt_optimise: enhanced_prompt,
                model:           model_name,
                aspect_ratio:    ratio || "LANDSCAPE",
                generation_type,
                seed:            result.seed || seed || null,
            });

            // Finalise media record
            await this.db.media.updateFields(mediaId, {
                generation_config_id: mediaConfig.id,
                url:    fileUrl,
                width:  result.width  || width  || 1024,
                height: result.height || height || 1024,
            });
            await markMediaStatus(this.db, mediaId, "success");

            return { fileUrl, mediaId, workflowId: workflow.id };

        } catch (err) {
            console.error(
                `[ImageTreatment] variation:${variationIndex} failed | ${err.message}`
            );
            await markMediaStatus(this.db, mediaId, "failed", err.message);
            throw err;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EXECUTE  (legacy entry-point — skips the queue)
    //    Calls prepare() then run() in background.
    //    Use only when you don't need queue control.
    // ─────────────────────────────────────────────────────────────────────────

    async execute(input) {
        const task = await this.prepare(input);

        console.log(
            `[ImageTreatment] execute (no queue) | ` +
            `count:${task.count} | batch:${task.batchId ?? "none"}`
        );

        this._runBackground(task).catch(err => {
            console.error(`[ImageTreatment] Background error: ${err.message}`);
        });

        return {
            batchId:   task.batchId,
            configId:  task.configId,
            workflows: task.workflows,
            status:    "processing",
            provider:  model_name,
        };
    }

    async _runBackground(task) {
        await this.run(task);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // RETRY  (not yet implemented)
    // ─────────────────────────────────────────────────────────────────────────

    async retryExecution(batchId, userId) {
        throw new Error("Retry not yet implemented for new schema.");
    }
}