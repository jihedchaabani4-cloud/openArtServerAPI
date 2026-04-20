import { ReferenceProcessor } from "#utils/ReferenceProcessor.js";
import { getStandardSize } from "#utils/sizeUtils.js";
import { getImageModel } from "#image/core/modelRouter.js";
import { verifyAndClampParams } from "../utils/treatmentUtils.js";
import { appendMediaToWorkflow, markMediaStatus } from "#db/workflowMediaOps.js";

/**
 * EditImageTreatment
 *
 * Architecture mirrors GenerateImageTreatment:
 *   prepare() → validates input, resolves provider (as string), creates DB records
 *               returns plain JSON-serializable descriptor — safe for Redis
 *
 *   run(task) → receives descriptor, calls provider, uploads, finalises DB
 *               Skips prompt enhancement to preserve the user's edit intent.
 *
 *   execute() → legacy entry-point (prepare + run in background, no queue)
 */
export class EditImageTreatment {
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

    _resolveProvider(model_name, input) {
        const { references = [] } = input;
        const route = getImageModel(model_name);
        if (!route) throw new Error(`Model "${model_name}" not found.`);

        const isMulti = references.length > 1;
        const provider = (isMulti && route.i2iMulti)
            || route.i2i
            || route.t2i;

        if (!provider) throw new Error(`Provider not found for model "${model_name}"`);
        return provider;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. PREPARE
    // ─────────────────────────────────────────────────────────────────────────

    async prepare(input) {
        const {
            prompt,
            model_name      = "nanobana",
            ratio,
            quality,
            project_id,
            session_id,
            workflow_id,
            media_id,
            upscaleScale,
        } = input;

        const userId = input.userId || input.user_id;

        if (!userId)      throw new Error("userId required");
        if (!project_id)  throw new Error("project_id required");
        if (!session_id)  throw new Error("session_id required");
        if (!workflow_id) throw new Error("workflow_id required for edit");

        // 1a. Resolve provider (validate model exists)
        const provider = this._resolveProvider(model_name, input);

        // 1b. Verify & clamp params
        const verified = verifyAndClampParams(provider, { ratio, quality, count: 1 });

        // 1c. Build references
        //     - explicit media_id → inject as a regular source reference (not base image)
        //     - no media_id      → auto-resolve primary media URL from the workflow
        let rawRefs = input.references || [];

        const resolveId = media_id || null;
        if (resolveId && !rawRefs.find(r => r.media_id === resolveId || r.asset_id === resolveId)) {
            // Explicit media — add as source reference, NOT as base image
            rawRefs = [{ media_id: resolveId, role: "source", is_base: false }, ...rawRefs];
        } else if (!resolveId) {
            // No media_id — resolve primary media from the workflow
            const primaryMedia = await this.db.workflows.getPrimaryMedia(workflow_id);
            if (primaryMedia?.url && !rawRefs.find(r => r.url === primaryMedia.url)) {
                rawRefs = [{ url: primaryMedia.url, media_id: primaryMedia.id, role: "source", is_base: false }, ...rawRefs];
            }
        }

        // 1d. Process references
        const input_assets = await this.refProcessor.process(
            rawRefs, userId, project_id, session_id, "uploads"
        );

        // 1e. Size
        const sizeInfo = this._getStandardSize(verified.ratio, verified.quality);

        // 1f. Determine generation_type
        const generation_type = input_assets.length > 0 ? "TEXT_REFERENCES" : "TEXT_ONLY";

        // 1g. Create generation_config
        const config = await this.db.configs.createConfig({
            prompt,
            model:        model_name,
            aspect_ratio: verified.ratio || "LANDSCAPE",
            generation_type,
        });

        // 1h. Attach references to config (all are regular references)
        for (let i = 0; i < input_assets.length; i++) {
            const asset = input_assets[i];
            if (asset.media_id) {
                await this.db.configs.createReference({
                    generation_config_id: config.id,
                    position:    i,
                    input_type:  "IMAGE_INPUT_TYPE_REFERENCE",
                    ref_media_id: asset.media_id,
                });
            }
        }

        // 1i. Fetch existing workflow
        const wf = await this.db.workflows.getWorkflow(workflow_id);
        if (!wf) throw new Error(`Workflow "${workflow_id}" not found`);

        // 1j. Create placeholder media on the EXISTING workflow
        const media = await appendMediaToWorkflow(this.db, {
            workflow_id: wf.id,
            mediaData: {
                project_id,
                generation_config_id: config.id,
                step_id: "EDIT",
                url:    null,
                width:  sizeInfo?.width  || 1024,
                height: sizeInfo?.height || 1024,
            },
            initialStatus: "processing",
        });

        // 1k. Safety check — reject bad prompts before queuing
        const safety = await this.promptService.checkPrompt(prompt);
        if (!safety.safe) {
            await markMediaStatus(this.db, media.id, "failed", safety.reason);
            throw new Error(`Prompt rejected: ${safety.reason}`);
        }

        console.log(
            `[EditImageTreatment] prepare | workflow:${wf.id} | media:${media.id} | ` +
            `model:${model_name} | refs:${input_assets.length}`
        );

        return {
            userId,
            project_id,
            session_id,
            workflow_id,
            model_name,
            prompt,
            generation_type,
            ratio:          verified.ratio,
            quality:        verified.quality,
            size:           sizeInfo?.size   || null,
            width:          sizeInfo?.width  || null,
            height:         sizeInfo?.height || null,
            input_assets,
            upscaleScale:   upscaleScale || null,
            configId:       config.id,
            workflow:       wf,
            mediaId:        media.id,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. RUN
    //    Receives the descriptor from prepare() (via Redis → Scheduler).
    //    Runs the edit, uploads result, finalises DB.
    //    NOTE: No prompt enhancement — user's edit intent is preserved verbatim.
    // ─────────────────────────────────────────────────────────────────────────

    async run(task) {
        const {
            userId,
            model_name,
            prompt,
            generation_type,
            ratio, quality, size, width, height,
            input_assets, upscaleScale,
            configId,
            workflow, mediaId,
        } = task;

        const startTime = Date.now();

        // Re-resolve provider (not serializable)
        const provider = this._resolveProvider(model_name, { references: input_assets });

        // 2a. Build final prompt
        // For edits → NO creative enhancement, preserve user intent.
        let finalPrompt = prompt;

        console.log(`   ✏️  [EditImageTreatment] Edit prompt: "${finalPrompt.substring(0, 100)}..."`);

        // 2c. Resolve source image (first source-role asset)
        const sourceAsset = (input_assets || []).find(a => ["source", "normal", "start"].includes(a.role));
        const image_url   = sourceAsset?.url || null;

        // 2d. Build provider form
        const form = {
            prompt:          finalPrompt,
            ratio, quality, size, width, height,
            image:           image_url,
            image_url:       image_url,
            references:      input_assets,
            ...(upscaleScale ? { scale: upscaleScale } : {}),
        };

        // 2e. Build payload — modern or legacy pattern
        let payload;
        if (typeof provider.buildPayload === "function") {
            payload = provider.buildPayload(form);
        } else if (typeof provider.adapt === "function") {
            const adapted = provider.adapt(form);
            payload = provider.toPayload ? provider.toPayload(adapted) : adapted;
        } else {
            payload = form;
        }

        console.log(
            `[EditImageTreatment] workflow:${workflow.id} | calling provider (${provider.constructor.name})...`
        );

        // 2f. Call provider
        let result;
        try {
            result = await provider.generate(payload);
            console.log(`   ✅ [EditImageTreatment] Provider returned OK`);
        } catch (err) {
            const msg = err?.response?.data?.detail || err.message;
            console.error(`❌ [EditImageTreatment] Provider call failed: ${msg}`);
            await markMediaStatus(this.db, mediaId, "failed", msg);
            throw new Error(msg);
        }

        // 2g. Upload result — support both URL and base64 outputs
        let fileUrl;
        try {
            const uniqueSuffix = `${Date.now()}_${Math.floor(Math.random() * 1000)}`;
            const fileName     = `${userId}/edits/${workflow.id}_${uniqueSuffix}.png`;

            if (result.image_url || result.url) {
                fileUrl = await this.storageService.uploadFromUrl(fileName, result.image_url || result.url);
            } else if (result.image_base64) {
                fileUrl = await this.storageService.upload(fileName, result.image_base64);
            } else {
                throw new Error("Provider returned no output (no image_url or image_base64)");
            }

            console.log(`   ☁️  [EditImageTreatment] Uploaded → ${fileUrl}`);
        } catch (err) {
            console.error(`❌ [EditImageTreatment] Upload failed: ${err.message}`);
            await markMediaStatus(this.db, mediaId, "failed", err.message);
            throw err;
        }

        // 2h. Persist to DB
        try {
            const mediaConfig = await this.db.configs.createConfig({
                prompt:              finalPrompt,
                model:               model_name || "unknown",
                aspect_ratio:        ratio || "LANDSCAPE",
                generation_type,
                media_generation_id: result.mediaGenerationId || null,
            });

            for (let j = 0; j < (input_assets || []).length; j++) {
                const asset = input_assets[j];
                if (asset.media_id) {
                    await this.db.configs.createReference({
                        generation_config_id: mediaConfig.id,
                        position:    j,
                        input_type:  "IMAGE_INPUT_TYPE_REFERENCE",
                        ref_media_id: asset.media_id,
                    });
                }
            }

            await this.db.media.updateFields(mediaId, {
                generation_config_id: mediaConfig.id,
                url:    fileUrl,
                width:  result.width  || width  || 1024,
                height: result.height || height || 1024,
            });
            await markMediaStatus(this.db, mediaId, "success");

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(
                `\n✅ [EditImageTreatment] Done in ${elapsed}s — workflow:${workflow.id} → media:${mediaId}`
            );

            return { configId, mediaId, workflowId: workflow.id };

        } catch (dbErr) {
            console.error(`❌ [EditImageTreatment] DB persist failed: ${dbErr.message}`);
            await markMediaStatus(this.db, mediaId, "failed", dbErr.message);
            throw dbErr;
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EXECUTE  (legacy entry-point — skips the queue)
    // ─────────────────────────────────────────────────────────────────────────

    async execute(input) {
        const task = await this.prepare(input);

        console.log(
            `[EditImageTreatment] execute (no queue) | workflow:${task.workflow.id} | media:${task.mediaId}`
        );

        this.run(task).catch(err => {
            console.error(`[EditImageTreatment] Background error: ${err.message}`);
        });

        return {
            batchId:   null,
            configId:  task.configId,
            workflows: [task.workflow],
            status:    "processing",
            provider:  task.model_name,
        };
    }
}
