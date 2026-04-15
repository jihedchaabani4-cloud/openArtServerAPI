import { ReferenceProcessor } from "#utils/ReferenceProcessor.js";
import { detectMode          } from "#video/core/detectMode.js";
import { getRunner, getModelName, ROUTED_MODELS } from "#video/core/modelRouter.js";
import { appendMediaToWorkflow, markMediaStatus } from "#db/workflowMediaOps.js";

const METHOD_MAP = {
    "t2v":    (p, payload, mode) => p.generate ? p.generate(payload, mode) : p.textToVideo(payload),
    "i2v":    (p, payload, mode) => p.generate ? p.generate(payload, mode) : p.imageToVideo(payload),
    "motion": (p, payload, mode) => p.generate ? p.generate(payload, mode) : p.motionControl(payload),
    "r2v":    (p, payload, mode) => p.generate ? p.generate(payload, mode) : (p.imageToVideo ? p.imageToVideo(payload) : p.generate(payload, mode)),
    "v2v":    (p, payload, mode) => p.generate ? p.generate(payload, mode) : p.videoToVideo(payload),
};

export class VideoTreatment {
    constructor({ promptService, storageService, db }) {
        this.promptService  = promptService;
        this.storageService = storageService;
        this.db             = db; // { projects, sessions, batches, workflows, media, configs }
        this.refProcessor   = new ReferenceProcessor({ storageService, db });
    }

    async execute(input) {
        const {
            model             = "kling_v3",
            prompt            = "",
            ratio             = "16:9",
            duration          = "5s",
            project_id,
            session_id,
            references        = [],
            sound,
            cfgScale,
            negativePrompt    = "",
            multiPrompt,
            keepOriginalSound,
            video_resolution,
            camera_control,
            cameraControl,
        } = input;

        const userId    = input.userId || input.user_id;
        const startTime = Date.now();

        if (!project_id) throw new Error("project_id required");
        if (!session_id) throw new Error("session_id required");

        // 1. Detect mode
        const mode = detectMode(references);

        // 2. Resolve provider via the model router
        const provider = getRunner(model, mode);
        if (!provider) {
            throw new Error(
                `Model "${model}" not supported for mode "${mode}". Available: ${ROUTED_MODELS.join(", ")}`
            );
        }

        // 3. Resolve references (upload if needed)
        const maxRefs      = provider.maxReferences ?? 1;
        const rawRefs      = references.slice(0, maxRefs);
        const input_assets = await this.refProcessor.process(
            rawRefs, userId, project_id, session_id, "video_uploads"
        );
        const resolvedRefs = rawRefs.map((ref, i) => ({
            ...ref,
            url: input_assets[i]?.url || ref.url,
        }));

        // 4. Build form
        const form = {
            prompt, model, ratio,
            duration:      parseFloat(String(duration)) || 5,
            resolution:    video_resolution,
            sound, cfgScale, negativePrompt, multiPrompt, keepOriginalSound,
            cameraControl: cameraControl || camera_control,
            references:    resolvedRefs,
        };

        const model_name = getModelName(model, mode);

        // 5. Create generation_config (batch-level)
        const config = await this.db.configs.createConfig({
            prompt,
            model: model_name,
            aspect_ratio: ratio || "16:9",
            generation_type: input_assets.length > 0 ? "TEXT_REFERENCES" : "TEXT_ONLY",
        });

        // 6. Attach references to config
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

        // 7. Create workflow (no batch — single video generation)
        const displayName = prompt
            ? prompt.substring(0, 60)
            : "Video Generation";

        const workflow = await this.db.workflows.createWorkflow({
            project_id,
            session_id,
            display_name:    displayName,
            variation_index: 0,
        });

        // 8. Return immediately — generation runs in background
        console.log(`\n🚀 [VideoTreatment] single generation | workflow:${workflow.id} | mode:${mode}`);

        this._runBackground({
            provider, form, mode,
            batchId:    null,
            configId:   config.id,
            workflow,
            input_assets,
            userId, project_id, session_id, startTime,
            model_name,
        }).catch(err => {
            console.error(`❌ [VideoTreatment] Background Error: ${err.message || err}`);
        });

        return {
            batchId:   null,
            configId:  config.id,
            workflows: [workflow],
            status:    "processing",
            mode,
            model:     model_name,
        };
    }

    async _runBackground({
        provider, form, mode,
        batchId, configId, workflow,
        input_assets,
        userId, project_id, session_id, startTime,
        model_name,
    }) {
        const media = await appendMediaToWorkflow(this.db, {
            workflow_id: workflow.id,
            mediaData: {
                project_id,
                generation_config_id: configId,
                step_id: "CAE",
                url: null,
                width: 1280,
                height: 720,
            },
            initialStatus: "processing",
        });

        // Safety check
        const safety = await this.promptService.checkPrompt(form.prompt);
        if (!safety.safe) {
            console.warn(`⚠️ [VideoTreatment] Prompt rejected: ${safety.reason}`);
            await markMediaStatus(this.db, media.id, "failed", safety.reason);
            return;
        }

        // adapt → toPayload → call API
        const adapted = provider.adapt(form, mode);
        const payload = provider.toPayload(adapted, mode);

        const runner = (provider.variants && provider.variants[mode]) || provider;
        console.log(`\n   ⚙️ [VideoTreatment] Calling Provider API (${runner.modelName || model_name})`);

        const executeMethod = METHOD_MAP[provider.type] || METHOD_MAP["t2v"];
        const result        = await executeMethod(provider, payload, mode);

        console.log(`\n   ✅ [VideoTreatment] Provider returned output successfully.`);

        const outputUrl = result.video_url || result.image_url;
        if (!outputUrl) {
            await markMediaStatus(this.db, media.id, "failed", "Provider returned no output URL");
            throw new Error("Provider returned no output URL");
        }

        // Upload to storage
        console.log(`\n   ☁️ [VideoTreatment] Uploading to Storage...`);
        const fileName = `${userId}/videos/${batchId || workflow.id}_${Date.now()}.mp4`;
        const fileUrl  = await this.storageService.uploadFromUrl(fileName, outputUrl);
        console.log(`      ↳ ${fileUrl}`);

        // Create per-media generation_config (with seed if provider returns one)
        const mediaConfig = await this.db.configs.createConfig({
            prompt:          form.prompt,
            model:           model_name,
            aspect_ratio:    form.ratio || "16:9",
            generation_type: input_assets.length > 0 ? "TEXT_REFERENCES" : "TEXT_ONLY",
            seed:            result.seed || null,
        });

        // Create Media record (new 7-table schema)
        await this.db.media.updateFields(media.id, {
            generation_config_id: mediaConfig.id,
            url: fileUrl,
            width: result.width || 1280,
            height: result.height || 720,
        });
        await markMediaStatus(this.db, media.id, "success");

        console.log(`✅ [VideoTreatment] Done: batch ${batchId} → media:${media.id}`);
    }
}
