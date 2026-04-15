import { GenerateImageTreatment } from "./ImageTreatment.js";
import { getImageModel } from "#image/core/modelRouter.js";
import { runImageGenerationTask } from "../tasks/ImageGenerationTask.js";
import { verifyAndClampParams } from "../utils/treatmentUtils.js";

export class CameraTreatment extends GenerateImageTreatment {
    constructor(deps) {
        super(deps);
    }

    /**
     * Specialized execute for camera angle changes.
     * Reuses an existing workflow and adds a new media record to it.
     */
    async execute(input) {
        let {
            rotation, tilt, zoom,
            project_id, session_id, workflow_id, media_id,
            ratio, quality, model_name = "seedream-pro",
            negative_prompt, strength, steps, guidance_scale,
            seed, userId, references = []
        } = input;

        // 🔍 Auto-resolve media_id from references if not provided
        if (!media_id && references && references.length > 0) {
            media_id = references[0].id || references[0].media_id || references[0].asset_id;
        }

        // 🔍 Auto-resolve workflow_id from media record if not provided
        if (!workflow_id && media_id) {
            try {
                const media = await this.db.media.findById(media_id);
                if (media && media.workflow_id) {
                    workflow_id = media.workflow_id;
                    console.log(`✨ [CameraTreatment] Resolved workflow_id: ${workflow_id} from media record.`);
                }
            } catch (err) {
                console.warn(`⚠️ [CameraTreatment] Could not resolve workflow_id from media_id ${media_id}: ${err.message}`);
            }
        }

        if (!project_id)  throw new Error("project_id required");
        if (!session_id)  throw new Error("session_id required");
        if (!workflow_id) throw new Error("workflow_id required for camera angle edit");

        const startTime = Date.now();

        // 1. Map zoom level to descriptive text
        let zoomText = "medium shot";
        if (zoom <= 2)      zoomText = "extreme close-up";
        else if (zoom <= 4) zoomText = "close-up";
        else if (zoom <= 6) zoomText = "medium shot";
        else if (zoom <= 8) zoomText = "wide shot";
        else                zoomText = "extreme wide shot";

        // 2. Prepare the prompt
        const cameraPrompt = `Change the camera angle of the original image while keeping the same people, environment, lighting, and style.

Camera position:
- Horizontal angle: ${rotation} degrees
- Vertical angle: ${tilt} degrees
- Camera distance: ${zoomText}

Maintain:
- Same subjects
- Same clothing
- Same environment
- Same lighting
- Same composition style

Photorealistic, cinematic, natural perspective, realistic camera lens, high detail, consistent identity`;

        console.log(`🎥 [CameraTreatment] Generated camera prompt: rotation:${rotation}, tilt:${tilt}, zoom:${zoomText}`);

        // 3. Resolve model & provider
        const route = getImageModel(model_name);
        if (!route) throw new Error(`Model "${model_name}" not found.`);
        const provider = route.i2i || route.t2i; // Default to i2i for edit action

        // 4. Verify & Clamp params
        const verified = verifyAndClampParams(provider, { steps, guidance_scale, ratio, quality, count: 1 });

        // 5. Process references
        let rawRefs = input.references || [];
        // Ensure the media_id being edited is treated as the base image
        if (media_id && !rawRefs.find(r => (r.media_id === media_id || r.id === media_id || r.asset_id === media_id))) {
            rawRefs.unshift({
                media_id,
                role: "IMAGE_INPUT_TYPE_BASE_IMAGE",
                is_base: true
            });
        }
        const input_assets = await this.refProcessor.process(rawRefs, userId, project_id, session_id, "uploads");

        // 6. Asset Size
        const sizeInfo = this._getStandardSize(verified.ratio, verified.quality);

        // 7. DB: Create generation_config
        const generation_type = "TEXT_BASE_IMAGE_REFERENCES";
        const config = await this.db.configs.createConfig({
            prompt: cameraPrompt,
            model: model_name,
            aspect_ratio: verified.ratio || "LANDSCAPE",
            generation_type,
        });

        // Attach references
        for (let i = 0; i < input_assets.length; i++) {
            const asset = input_assets[i];
            if (asset.media_id) {
                await this.db.configs.createReference({
                    generation_config_id: config.id,
                    position: i,
                    input_type: asset.is_base ? "IMAGE_INPUT_TYPE_BASE_IMAGE" : "IMAGE_INPUT_TYPE_REFERENCE",
                    ref_media_id: asset.media_id,
                });
            }
        }

        // 8. Get existing workflow
        const wf = await this.db.workflows.getWorkflow(workflow_id);
        if (!wf) throw new Error(`Workflow ${workflow_id} not found`);

        // 9. Trigger background task
        const context = { promptService: this.promptService, storageService: this.storageService, db: this.db };
        runImageGenerationTask(context, {
            provider,
            batchId: null,
            configId: config.id,
            workflows: [wf], // Reuse existing workflow
            generation_type,
            prompt: cameraPrompt,
            negative_prompt,
            ratio: verified.ratio,
            quality: verified.quality,
            size: sizeInfo?.size || null,
            width: sizeInfo?.width || null,
            height: sizeInfo?.height || null,
            userId,
            input_assets,
            startTime,
            steps: verified.steps,
            guidance_scale: verified.guidance_scale,
            seed,
            project_id,
            session_id,
            model_name,
            count: 1,
        }).catch(err => {
            console.error(`❌ [CameraTreatment] Unhandled: ${err.message}`);
        });

        return {
            batchId: null,
            configId: config.id,
            workflows: [wf],
            status: "processing",
            provider: `${model_name} → ${provider.constructor.name}`,
        };
    }
}
