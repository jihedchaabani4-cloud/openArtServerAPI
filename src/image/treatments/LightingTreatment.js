import { GenerateImageTreatment } from "./ImageTreatment.js";
import { getImageModel } from "#image/core/modelRouter.js";
import { runImageGenerationTask } from "../tasks/ImageGenerationTask.js";
import { verifyAndClampParams } from "../utils/treatmentUtils.js";

export class LightingTreatment extends GenerateImageTreatment {
    constructor(deps) {
        super(deps);
    }

    /**
     * Specialized execute for lighting adjustments.
     * Reuses an existing workflow and adds a new media record to it.
     */
    async execute(input) {
        let {
            angle, elevation, intensity, type, brightness, color,
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
                    console.log(`✨ [LightingTreatment] Resolved workflow_id: ${workflow_id} from media record.`);
                }
            } catch (err) {
                console.warn(`⚠️ [LightingTreatment] Could not resolve workflow_id from media_id ${media_id}: ${err.message}`);
            }
        }

        if (!project_id)  throw new Error("project_id required");
        if (!session_id)  throw new Error("session_id required");
        if (!workflow_id) throw new Error("workflow_id required for lighting edit");

        const startTime = Date.now();

        // 1. Map lighting parameters to descriptive text
        const lightType = type === "hard" ? "sharp, hard directional light" : "soft, diffused ambient light";
        const colorDesc = color && color !== "#ffffff" ? `with a ${color} color tint` : "with white natural light";
        const brightnessDesc = brightness <= 20 ? "very dim" : brightness <= 40 ? "low" : brightness <= 60 ? "moderate" : brightness <= 80 ? "bright" : "very bright";
        const intensityDesc = intensity <= 2 ? "subtle" : intensity <= 5 ? "moderate" : intensity <= 8 ? "strong" : "intense";

        // 2. Map angle/elevation to directional description
        let directionDesc = "";
        if (elevation > 60)       directionDesc = "overhead top-down light";
        else if (elevation > 30)  directionDesc = "high-angle light from above";
        else if (elevation > -10) directionDesc = "eye-level side lighting";
        else if (elevation > -40) directionDesc = "low-angle light from below";
        else                      directionDesc = "dramatic under-lighting";

        const horizontalDir = angle < 45 ? "front"
            : angle < 135 ? "right side"
            : angle < 225 ? "back"
            : angle < 315 ? "left side"
            : "front";

        // 3. Build lighting prompt
        const lightingPrompt = `Relighting of the original image — change only the lighting while keeping the same subjects, composition, environment, and style.

Lighting setup:
- Type: ${lightType}
- Direction: ${directionDesc}, from the ${horizontalDir}
- Brightness: ${brightnessDesc} (${brightness}/100)
- Intensity: ${intensityDesc} (${intensity}/10)
- Color: ${colorDesc}

Keep unchanged:
- Same subjects and their identity
- Same clothing and accessories
- Same background and environment
- Same composition and framing
- Same textures and materials

Photorealistic, cinematic relighting, high detail, consistent identity, physically accurate shadows and highlights.`;

        console.log(`💡 [LightingTreatment] Generated lighting prompt: type:${type}, angle:${angle}°, elevation:${elevation}°, brightness:${brightness}`);

        // 4. Resolve model & provider
        const route = getImageModel(model_name);
        if (!route) throw new Error(`Model "${model_name}" not found.`);
        const provider = route.i2i || route.t2i;

        // 5. Verify & Clamp params
        const verified = verifyAndClampParams(provider, { steps, guidance_scale, ratio, quality, count: 1 });

        // 6. Process references
        let rawRefs = input.references || [];
        if (media_id && !rawRefs.find(r => (r.media_id === media_id || r.id === media_id || r.asset_id === media_id))) {
            rawRefs.unshift({
                media_id,
                role: "IMAGE_INPUT_TYPE_BASE_IMAGE",
                is_base: true
            });
        }
        const input_assets = await this.refProcessor.process(rawRefs, userId, project_id, session_id, "uploads");

        // 7. Asset Size
        const sizeInfo = this._getStandardSize(verified.ratio, verified.quality);

        // 8. DB: Create generation_config
        const generation_type = "TEXT_BASE_IMAGE_REFERENCES";
        const config = await this.db.configs.createConfig({
            prompt: lightingPrompt,
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

        // 9. Get existing workflow
        const wf = await this.db.workflows.getWorkflow(workflow_id);
        if (!wf) throw new Error(`Workflow ${workflow_id} not found`);

        // 10. Trigger background task
        const context = { promptService: this.promptService, storageService: this.storageService, db: this.db };
        runImageGenerationTask(context, {
            provider,
            batchId: null,
            configId: config.id,
            workflows: [wf],
            generation_type,
            prompt: lightingPrompt,
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
            console.error(`❌ [LightingTreatment] Unhandled: ${err.message}`);
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
