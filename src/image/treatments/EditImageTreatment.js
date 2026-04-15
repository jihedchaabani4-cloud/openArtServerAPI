import { ReferenceProcessor } from "#utils/ReferenceProcessor.js";
import { getStandardSize } from "#utils/sizeUtils.js";
import { getImageModel, ROUTED_IMAGE_MODELS } from "#image/core/modelRouter.js";
import { runImageEditTask } from "../tasks/ImageEditTask.js";
import { verifyAndClampParams } from "../utils/treatmentUtils.js";

/**
 * EditImageTreatment
 * Handles editing an existing workflow by adding new media to it
 * instead of creating a new workflow.
 */
export class EditImageTreatment {
    constructor({ promptService, models, storageService, db }) {
        this.promptService  = promptService;
        this.models         = models;
        this.storageService = storageService;
        this.db             = db; 
        this.refProcessor   = new ReferenceProcessor({ storageService, db });
    }

    _getStandardSize(ratio, quality) {
        return getStandardSize(ratio, quality);
    }

    async execute(input) {
        const {
            prompt, negative_prompt, model_name = "nanobana",
            ratio, quality, project_id, session_id,
            image_base64, strength, steps, guidance_scale,
            seed, workflow_id, media_id, userId,
            mask_selection, // Receive mask_selection from input
        } = input;

        if (!project_id) throw new Error("project_id required");
        if (!session_id) throw new Error("session_id required");
        if (!workflow_id) throw new Error("workflow_id required for edit");

        const startTime = Date.now();

        // 1. Resolve model & provider
        const route = getImageModel(model_name);
        if (!route) throw new Error(`Model "${model_name}" not found.`);

        // For edit, we default to i2i
        const provider = route.i2i || route.t2i;
        if (!provider) throw new Error(`Provider not found for model ${model_name}`);

        // 2. Verify params
        const verified = verifyAndClampParams(provider, { steps, guidance_scale, ratio, quality, count: 1 });
        
        // 3. Process references
        let rawRefs = input.references || [];
        
        // If media_id is provided, ensure it's treated as the base image for the edit
        if (media_id && !rawRefs.find(r => r.media_id === media_id || r.asset_id === media_id)) {
            rawRefs.unshift({
                media_id,
                role: "IMAGE_INPUT_TYPE_BASE_IMAGE",
                is_base: true
            });
        }

        const input_assets = await this.refProcessor.process(rawRefs, userId, project_id, session_id, "uploads");

        // 4. Size
        const sizeInfo = this._getStandardSize(verified.ratio, verified.quality);

        // 5. DB: Create generation_config for this edit
        const hasActualBase = !!image_base64 || input_assets.some(a => a.is_base);
        const generation_type = hasActualBase ? "TEXT_BASE_IMAGE" : "TEXT_ONLY";
        const config = await this.db.configs.createConfig({
            prompt, 
            model: model_name, 
            aspect_ratio: verified.ratio || "LANDSCAPE",
            generation_type,
        });

        // Attach refs to config
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

        // 6. Get existing workflow
        const wf = await this.db.workflows.getWorkflow(workflow_id);
        if (!wf) throw new Error(`Workflow ${workflow_id} not found`);

        // 7. Trigger background task
        // We pass the existing workflow in an array so ImageGenerationTask adds media to it
        const context = { promptService: this.promptService, storageService: this.storageService, db: this.db };
        
        runImageEditTask(context, {
            provider,
            configId: config.id,
            workflow: wf,             // single existing workflow
            generation_type,
            prompt: prompt,           // raw user prompt — task handles enhancement
            negative_prompt,
            ratio: verified.ratio,
            quality: verified.quality,
            size: sizeInfo.size,
            width: sizeInfo.width,
            height: sizeInfo.height,
            userId,
            input_assets,
            image_base64,
            strength,
            startTime,
            steps: verified.steps,
            guidance_scale: verified.guidance_scale,
            seed,
            project_id,
            session_id,
            model_name,
            mask_selection,
        }).catch(err => {
            console.error(`❌ [EditImageTreatment] Unhandled: ${err.message}`);
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
