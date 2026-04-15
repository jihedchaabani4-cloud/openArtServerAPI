import { ReferenceProcessor } from "#utils/ReferenceProcessor.js";
import { getStandardSize } from "#utils/sizeUtils.js";
import { Errors } from "../../errors/GenerationErrors.js";
import { getImageModel, ROUTED_IMAGE_MODELS } from "#image/core/modelRouter.js";
import { runImageGenerationTask } from "../tasks/ImageGenerationTask.js";
import { verifyAndClampParams } from "../utils/treatmentUtils.js";

export class GenerateImageTreatment {
    constructor({ promptService, models, storageService, db }) {
        this.promptService  = promptService;
        this.models         = models;
        this.storageService = storageService;
        this.db             = db; // { projects, sessions, batches, workflows, media, configs }
        this.refProcessor   = new ReferenceProcessor({ storageService, db });
    }

    _getStandardSize(ratio, quality) {
        return getStandardSize(ratio, quality);
    }

    // ─────────────────────────────────────────
    // MAIN EXECUTE
    // ─────────────────────────────────────────
    async execute(input) {
        const prompt          = input.prompt;
        const negative_prompt = input.negative_prompt || "";
        const userPlan        = input.userPlan        || "free";
        const model_name      = input.model_name      || "nanobana";
        let ratio             = input.ratio;
        let quality           = input.quality;
        const project_id      = input.project_id;
        const session_id      = input.session_id;
        const workflow_type   = input.workflow_type || "GENERATION"; // Fallback to standard
        const image_base64    = input.image_base64    || null;
        const strength        = input.strength;
        let steps             = input.steps;
        let guidance_scale    = input.guidance_scale;
        const seed            = input.seed;
        let count             = input.count || 1;

        const userId = input.userId || input.user_id || "e54d7d5f-9c49-457d-83b7-ac8484bceb80";
        if (!project_id)  throw new Error("project_id required");
        if (!session_id)  throw new Error("session_id required");

        const startTime = Date.now();

        // ─── Resolve model ───
        const route      = getImageModel(model_name);
        const modelGroup = route?.group || this.models[model_name];
        if (!modelGroup && !route) {
            throw new Error(`Model "${model_name}" not found. Available: ${ROUTED_IMAGE_MODELS.join(", ")}`);
        }

        // ─── Determine variant ───
        const hasBase       = !!image_base64;
        const rawRefs       = input.references || [];
        const hasInputRefs  = rawRefs.length > 0;
        const hasRefs       = hasInputRefs || hasBase;
        const isMulti       = rawRefs.length > 1;
        let variantKey      = hasRefs ? (isMulti ? "i2iMulti" : "i2i") : "t2i";

        let provider;
        if (route && route[variantKey])          provider = route[variantKey];
        else if (route && route["i2i"] && hasRefs) provider = route["i2i"];
        else if (route && route["t2i"])          provider = route["t2i"];
        else if (modelGroup?.resolve)            provider = modelGroup.resolve({ references: input.references || [], image_base64, edit_type: input.edit_type });
        else if (modelGroup)                     provider = modelGroup[variantKey] || (hasRefs ? modelGroup.i2i : null) || modelGroup.t2i || modelGroup;
        else                                     provider = modelGroup;

        if (!["t2i", "i2i"].includes(provider.type)) {
            throw new Error(`Model "${model_name}" is a video model. Use VideoTreatment instead.`);
        }

        // ─── Verify & Clamp params ───
        const verified = verifyAndClampParams(provider, { steps, guidance_scale, ratio, quality, count });
        steps          = verified.steps;
        guidance_scale = verified.guidance_scale;
        ratio          = verified.ratio;
        quality        = verified.quality;
        count          = verified.count;

        // ─── Process references ───
        const input_assets = await this.refProcessor.process(rawRefs, userId, project_id, session_id, "uploads");

        // ─── Size ───
        const sizeInfo = this._getStandardSize(ratio, quality);
        const size     = sizeInfo?.size   || null;
        const width    = sizeInfo?.width  || null;
        const height   = sizeInfo?.height || null;

        // ─── Determine generation type ───
        // ─── Determine generation type ───
        const hasActualBase = !!image_base64;
        const hasActualRefs = input_assets.length > 0;
        let generation_type = "TEXT_ONLY";
        
        if (hasActualRefs && hasActualBase)  generation_type = "TEXT_BASE_IMAGE_REFERENCES";
        else if (hasActualRefs)              generation_type = "TEXT_REFERENCES";
        else if (hasActualBase)              generation_type = "TEXT_BASE_IMAGE";

        console.log(`🎯 [ImageTreatment] Generation Type Identified: ${generation_type} (Refs: ${input_assets.length}, Base: ${hasActualBase})`);

        // ─── DB: Create shared generation_config (batch-level, no seed) ───
        const config = await this.db.configs.createConfig({
            prompt,
            model: `${model_name}`,
            aspect_ratio: ratio || "LANDSCAPE",
            generation_type,
        });

        // ─── DB: Attach references to config ───
        for (let i = 0; i < input_assets.length; i++) {
            const asset = input_assets[i];
            if (asset.media_id) {
                await this.db.configs.createReference({
                    generation_config_id: config.id,
                    position:   i,
                    input_type: asset.is_base ? "IMAGE_INPUT_TYPE_BASE_IMAGE" : "IMAGE_INPUT_TYPE_REFERENCE",
                    ref_media_id: asset.media_id,
                });
            }
        }

        // ─── DB: Create batch only when count > 1 ───
        let batch = null;
        if (count > 1) {
            batch = await this.db.batches.createBatch({
                project_id,
                session_id,
                generation_config_id: config.id,
                variation_count: count,
            });
        }

        // ─── DB: Create one workflow per variation ───
        const displayName = prompt ? prompt.substring(0, 60) : "Image Generation";
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

        // ─── Trigger background task ───
        const batchId = batch?.id || null;
        console.log(`\n🚀 [GenerateImageTreatment] Starting ${count > 1 ? `batch: ${batchId}` : 'single generation'} (${count} variation(s))`);

        const context = { promptService: this.promptService, storageService: this.storageService, db: this.db };

        runImageGenerationTask(context, {
            provider,
            batchId,
            configId: config.id,
            workflows,
            generation_type,
            prompt,
            negative_prompt,
            ratio, quality, size, width, height,
            userId,
            input_assets,
            image_base64,
            strength,
            startTime,
            steps,
            guidance_scale,
            seed,
            project_id,
            session_id,
            model_name,
            count,
            mask_selection:  input.mask_selection || null,
        }).catch(err => {
            console.error(`❌ [GenerateImageTreatment] Unhandled: ${err.message}`);
        });

        return {
            batchId,
            configId:  config.id,
            workflows,
            status:    "processing",
            provider:  `${model_name} → ${provider.constructor.name}`,
        };
    }

    async retryExecution(batchId, userId) {
        throw new Error("Retry not yet implemented for new schema.");
    }
}