import { ReferenceProcessor             } from "#utils/ReferenceProcessor.js";
import { getRunner, getModelName, ROUTED_MODELS } from "#video/core/modelRouter.js";
import { appendMediaToWorkflow, markMediaStatus, markMediaFailed } from "#db/workflowMediaOps.js";
import { verifyAndClampVideoParams        } from "#image/utils/treatmentUtils.js";
import { enqueueTreatmentJob }            from "#queue/treatmentJob.js";

/**
 * MotionTreatment
 *
 * Handles Image-to-Video animation where a driving video ("motion video")
 * is applied to a source image.
 *
 * Architecture:
 *   prepare() → validates input, builds form payload, creates DB records.
 *               Returns a plain JSON-serializable descriptor — safe to store in Redis.
 *
 *   run(task) → receives the prepared descriptor, calls provider API,
 *               uploads result to storage, finalises DB records.
 *               Called by the BullMQ worker via runJob() — never directly from the API.
 *
 *   execute() → legacy convenience entry-point (prepare + run in background).
 *               Still works for simple use-cases without the queue.
 */
export class MotionTreatment {
    constructor({ promptService, storageService, db }) {
        this.promptService  = promptService;
        this.storageService = storageService;
        this.db             = db;
        this.refProcessor   = new ReferenceProcessor({ storageService, db });
    }

    getQueueType() {
        return this.constructor.name;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. PREPARE
    //    • Validates all inputs
    //    • Resolves provider (by model name)
    //    • Creates generation_config + workflow + media placeholder in DB
    //    • Returns a plain object — no functions, no class instances.
    //      Everything run() needs is here, ready to be stored in Redis.
    // ─────────────────────────────────────────────────────────────────────────

    async prepare(input) {
        const {
            model        = "kling_v3",
            prompt       = "",
            ratio        = "16:9",
            duration     = "5s",
            project_id,
            session_id,
            image_url,
            video_url,
        } = input;

        const userId = input.userId || input.user_id;
        if (!userId)     throw new Error("userId required");
        if (!project_id) throw new Error("project_id required");
        if (!session_id) throw new Error("session_id required");

        const mode = "motion";

        // 1a. Resolve + validate provider
        const provider = getRunner(model, mode);
        if (!provider) {
            throw new Error(
                `Model "${model}" not supported for mode "${mode}". Available: ${ROUTED_MODELS.join(", ")}`
            );
        }

        if (!image_url || !video_url) {
            throw new Error("Motion Control requires both image_url and video_url.");
        }

        // 1b. Clamp params to provider limits
        const verified = verifyAndClampVideoParams(provider, { ratio, duration });

        // 1c. Build form payload (passed verbatim to run())
        const form = {
            prompt,
            model,
            ratio:    verified.ratio,
            duration: verified.duration,
            image:    image_url,
            video:    video_url,
        };

        const model_name = getModelName(model, mode);

        // 1d. Create generation_config (batch-level)
        const config = await this.db.configs.createConfig({
            prompt,
            model:           model_name,
            aspect_ratio:    verified.ratio || "16:9",
            generation_type: "TEXT_BASE_IMAGE",
        });

        // 1e. Resolve source dimensions from existing media records
        const input_assets = [
            { url: image_url, role: "source", type: "image_url", is_base: true  },
            { url: video_url, role: "video",  type: "video_url", is_base: false },
        ];

        let sourceWidth  = 1280;
        let sourceHeight = 720;

        for (let i = 0; i < input_assets.length; i++) {
            const asset         = input_assets[i];
            const existingMedia = await this.db.media.findByUrl(asset.url);
            if (existingMedia) {
                if (asset.role === "source") {
                    sourceWidth = existingMedia.width; sourceHeight = existingMedia.height;
                }
                await this.db.configs.createReference({
                    generation_config_id: config.id,
                    position:   i,
                    input_type: asset.is_base
                        ? "IMAGE_INPUT_TYPE_BASE_IMAGE"
                        : "IMAGE_INPUT_TYPE_REFERENCE",
                    ref_media_id: existingMedia.id,
                });
            }
        }

        // 1f. Create workflow record
        const displayName = prompt ? prompt.substring(0, 60) : "Motion Generation";
        const workflow    = await this.db.workflows.createWorkflow({
            project_id,
            session_id,
            display_name:    displayName,
            variation_index: 0,
        });

        // 1g. Create placeholder media row (status = "processing")
        const media = await appendMediaToWorkflow(this.db, {
            workflow_id: workflow.id,
            mediaData: {
                project_id,
                generation_config_id: config.id,
                step_id: "CAE",
                url:    null,
                width:  sourceWidth,
                height: sourceHeight,
            },
            initialStatus: "processing",
        });

        // Return fully-prepared descriptor — plain JSON, safe for Redis storage
        return {
            userId,
            project_id,
            model,          // string — run() uses this to re-resolve provider
            form,
            mode,
            model_name,
            configId:     config.id,
            workflow,
            mediaId:      media.id,
            sourceWidth,
            sourceHeight,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. RUN
    //    Receives the descriptor from prepare() via BullMQ worker execution.
    //    Steps:
    //      a. Safety-check prompt
    //      b. Call provider API
    //      c. Upload result to storage
    //      d. Persist final media record in DB
    // ─────────────────────────────────────────────────────────────────────────

    async run(task) {
        const {
            model, form, mode,
            userId, project_id,
            model_name, workflow,
            mediaId, input_assets,
            sourceWidth, sourceHeight,
        } = task;

        try {
            // Re-resolve provider from model string (providers are not serializable)
            const provider = getRunner(model, mode);

            // 2a. Prompt safety check
            if (form.prompt) {
                const safety = await this.promptService.checkPrompt(form.prompt);
                if (!safety.safe) {
                    console.warn(`[MotionTreatment] Prompt rejected: ${safety.reason}`);
                    await markMediaFailed(this.db, mediaId, safety.reason);
                    throw new Error(`Prompt rejected: ${safety.reason}`);
                }
            }

            // 2b. Adapt → payload → API call
            const adapted = provider.adapt(form, mode);
            const payload = provider.toPayload(adapted, mode);

            const runner = (provider.variants && provider.variants[mode]) || provider;
            console.log(
                `\n   [MotionTreatment] Calling Provider API (${runner.modelName})`,
                "\n      Payload Keys:", Object.keys(payload)
            );

            let result;
            if (provider.generate) {
                result = await provider.generate(payload, mode);
            } else if (provider.motionControl) {
                result = await provider.motionControl(payload);
            } else {
                throw new Error(
                    `Provider ${runner.modelName} does not implement motionControl or generate`
                );
            }

            const outputUrl = result.video_url || result.image_url;
            if (!outputUrl) {
                await markMediaFailed(this.db, mediaId, "Provider returned no output URL");
                throw new Error("Provider returned no output URL");
            }

            // 2c. Upload to storage
            console.log(`\n   [MotionTreatment] Uploading to Storage...`);
            const fileName = `${userId}/motion/${workflow.id}_${Date.now()}.mp4`;
            const fileUrl  = await this.storageService.uploadFromUrl(fileName, outputUrl);
            console.log(`      Upload OK: ${fileUrl}`);

            // 2d. Create per-media generation_config
            const mediaConfig = await this.db.configs.createConfig({
                prompt:          form.prompt,
                model:           model_name,
                aspect_ratio:    form.ratio || "16:9",
                generation_type: "TEXT_BASE_IMAGE",
                seed:            result.seed || null,
            });

            // 2e. Finalise media record
            await this.db.media.updateFields(mediaId, {
                generation_config_id: mediaConfig.id,
                url:    fileUrl,
                width:  result.width  || sourceWidth  || 1280,
                height: result.height || sourceHeight || 720,
            });
            await markMediaStatus(this.db, mediaId, "success");

            console.log(`[MotionTreatment] Done: workflow:${workflow.id} media:${mediaId}`);
            return { fileUrl, mediaId, workflowId: workflow.id };

        } catch (error) {
            console.error(`❌ [MotionTreatment] run() error:`, error.message);
            // Ensure the media record in DB is marked as failed so UI doesn't spin forever
            await markMediaFailed(this.db, mediaId, error);
            throw error; // Re-throw so Scheduler/caller also sees the failure
        }
    }

    async runJob(task) {
        return this.run(task);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // EXECUTE  (legacy entry-point — skips the queue)
    //    Calls prepare() then run() directly in the background.
    //    Use this only when you don't need queue control.
    // ─────────────────────────────────────────────────────────────────────────

    async execute(input) {
        const task = await this.prepare(input);
        const job = await enqueueTreatmentJob(this.getQueueType(), task);

        return {
            jobId: job.id,
            batchId:   null,
            configId:  task.configId,
            workflows: [task.workflow],
            status:    "queued",
            mode:      task.mode,
            model:     task.model_name,
        };
    }
}
