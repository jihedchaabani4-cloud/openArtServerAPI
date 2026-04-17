import { ReferenceProcessor             } from "#utils/ReferenceProcessor.js";
import { getRunner, getModelName, ROUTED_MODELS } from "#video/core/modelRouter.js";
import { appendMediaToWorkflow, markMediaStatus  } from "#db/workflowMediaOps.js";
import { verifyAndClampVideoParams        } from "#image/utils/treatmentUtils.js";

/**
 * MotionTreatment
 * 
 * Handles Image-to-Video animation where a driving video ("motion video") 
 * is applied to a source image, along with optional references.
 * Updated to use the new hierarchical DB schema.
 */
export class MotionTreatment {
    constructor({ promptService, storageService, db }) {
        this.promptService  = promptService;
        this.storageService = storageService;
        this.db             = db; // { projects, sessions, workflows, media, configs }
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
            image_base64,
            video_base64,
            references        = [],
            video_resolution,
            camera_control,
        } = input;

        const userId    = input.userId || input.user_id;
        if (!userId) throw new Error("userId required");
        const startTime = Date.now();

        if (!project_id) throw new Error("project_id required");
        if (!session_id) throw new Error("session_id required");

        const mode = "motion";

        // 1. Resolve provider
        const provider = getRunner(model, mode);
        if (!provider) {
            throw new Error(`Model "${model}" not supported or does not support motion. Available via router: ${ROUTED_MODELS.join(", ")}`);
        }

        // 2. Process references
        const maxRefs      = provider.maxReferences ?? 3;
        const rawRefs      = references.slice(0, maxRefs);
        const input_assets = await this.refProcessor.process(
            rawRefs, userId, project_id, session_id, "motion_uploads"
        );
        const resolvedRefs = rawRefs.map((ref, i) => ({
            ...ref,
            url: input_assets[i]?.url || ref.url,
        }));

        // Upload raw base64 inputs if provided
        let finalImageUrl = image_base64;
        if (finalImageUrl?.startsWith("data:image")) {
            finalImageUrl = await this.storageService.uploadBase64(
                `${userId}/inputs/${Date.now()}_img.png`, finalImageUrl
            );
        }
        let finalVideoUrl = video_base64;
        if (finalVideoUrl?.startsWith("data:video")) {
            finalVideoUrl = await this.storageService.uploadBase64(
                `${userId}/inputs/${Date.now()}_vid.mp4`, finalVideoUrl
            );
        }

        // 3. Verify & clamp params using provider's own defaults
        const verified = verifyAndClampVideoParams(provider, {
            ratio, duration,
        });

        // 4. Build form payload
        const form = {
            prompt, model,
            ratio:         verified.ratio,
            duration:      verified.duration,
            resolution:    video_resolution,
            image_base64:  finalImageUrl,
            video_base64:  finalVideoUrl,
            cameraControl: camera_control,
            references:    resolvedRefs,
        };

        const model_name = getModelName(model, mode);

        // 4. Create generation_config (batch-level)
        const config = await this.db.configs.createConfig({
            prompt,
            model: model_name,
            aspect_ratio: ratio || "16:9",
            generation_type: input_assets.length > 0 ? "TEXT_BASE_IMAGE_REFERENCES" : "TEXT_BASE_IMAGE",
        });

        // 5. Attach references to config
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

        // 6. Create workflow (no batch — single motion generation)
        const displayName = prompt
            ? prompt.substring(0, 60)
            : "Motion Generation";

        const workflow = await this.db.workflows.createWorkflow({
            project_id,
            session_id,
            display_name:    displayName,
            variation_index: 0,
        });

        // 7. Trigger background
        console.log(`\n🚀 [MotionTreatment] single generation | workflow:${workflow.id} | mode:${mode}`);
        
        this._runBackground({
            provider, form, mode,
            batchId:    null,
            configId:   config.id,
            workflow,
            input_assets,
            userId, project_id, session_id, startTime,
            model_name,
        }).catch(err => {
            console.error(`❌ [MotionTreatment] Background Error: ${err.message || err}`);
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

    async _runBackground({ provider, form, mode, batchId, configId, workflow, input_assets,
                           userId, project_id, session_id, startTime, model_name }) {
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
        if (form.prompt) {
            const safety = await this.promptService.checkPrompt(form.prompt);
            if (!safety.safe) {
                console.warn(`⚠️ [MotionTreatment] Prompt rejected: ${safety.reason}`);
                await markMediaStatus(this.db, media.id, "failed", safety.reason);
                return;
            }
        }

        // adapt → toPayload → call API
        const adapted = provider.adapt(form, mode);
        const payload = provider.toPayload(adapted, mode);

        const runner = (provider.variants && provider.variants[mode]) || provider;
        console.log(`\n   ⚙️ [MotionTreatment] Calling Provider API (${runner.modelName}) with Payload:`);
        console.log("      Payload Keys:", Object.keys(payload));

        let result;
        if (provider.generate) {
            result = await provider.generate(payload, mode);
        } else if (provider.motionControl) {
            result = await provider.motionControl(payload);
        } else {
            throw new Error(`Provider ${runner.modelName} does not implement motionControl or generate`);
        }

        console.log(`\n   ✅ [MotionTreatment] Provider returned output successfully.`);

        const outputUrl = result.video_url || result.image_url;
        if (!outputUrl) {
            await markMediaStatus(this.db, media.id, "failed", "Provider returned no output URL");
            throw new Error("Provider returned no output URL");
        }

        // Upload to Storage
        console.log(`\n   ☁️ [MotionTreatment] Uploading motion video to Storage...`);
        const fileName = `${userId}/motion/${workflow.id}_${Date.now()}.mp4`;
        const fileUrl  = await this.storageService.uploadFromUrl(fileName, outputUrl);
        console.log(`      ↳ Upload Successful! Public URL: ${fileUrl}`);

        // Create per-media generation_config
        const mediaConfig = await this.db.configs.createConfig({
            prompt:          form.prompt,
            model:           model_name,
            aspect_ratio:    form.ratio || "16:9",
            generation_type: input_assets.length > 0 ? "TEXT_BASE_IMAGE_REFERENCES" : "TEXT_BASE_IMAGE",
            seed:            result.seed || null,
        });

        // Create Media record (new schema)
        await this.db.media.updateFields(media.id, {
            generation_config_id: mediaConfig.id,
            url: fileUrl,
            width: result.width || 1280,
            height: result.height || 720,
        });
        await markMediaStatus(this.db, media.id, "success");

        console.log(`✅ [MotionTreatment] Done: workflow ${workflow.id} → media:${media.id}`);
    }
}
