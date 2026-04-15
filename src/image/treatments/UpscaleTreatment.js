import { ReferenceProcessor } from "#utils/ReferenceProcessor.js";
import { getUpscaleModel } from "#image/core/modelRouter.js";
import { getUpscaleRunner as getVideoUpscaleRunner } from "#video/core/modelRouter.js";
import { runUpscaleTask } from "../tasks/UpscaleTask.js";
import { runVideoUpscaleTask } from "../tasks/VideoUpscaleTask.js";

export class UpscaleTreatment {
    constructor({ storageService, db }) {
        this.storageService = storageService;
        this.db             = db; 
        this.refProcessor   = new ReferenceProcessor({ storageService, db });
    }

    _isVideoUrl(url = "") {
        const clean = String(url).split("?")[0].toLowerCase();
        return [".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv"].some((ext) => clean.endsWith(ext));
    }

    async execute(input) {
        const {
            project_id,
            session_id,
            workflow_id,
            media_id,
            upscaleScale,
            target_resolution,
            target_fps,
            userId,
        } = input;
        
        if (!project_id)  throw new Error("project_id required");
        if (!session_id)  throw new Error("session_id required");
        if (!media_id)    throw new Error("media_id required");

        const startTime = Date.now();

        const sourceMedia = await this.db.media.findById(media_id);
        if (!sourceMedia) throw new Error(`Media ${media_id} not found.`);

        const finalWorkflowId = workflow_id || sourceMedia.workflow_id;
        if (!finalWorkflowId) throw new Error("workflow_id could not be resolved from media_id.");

        // ─── Resolve source image URL ───
        const input_assets = await this.refProcessor.process(
            [{ url: null, media_id, role: "source", is_base: true }], 
            userId, project_id, session_id, "uploads"
        );
        const sourceAsset = input_assets[0];
        if (!sourceAsset || !sourceAsset.url) {
            throw new Error("Could not resolve source media URL for upscale.");
        }

        const isVideo = this._isVideoUrl(sourceAsset.url);
        const model_name = isVideo ? "topaz_video_upscale" : "topaz_image_upscale";

        let provider;
        if (isVideo) {
            provider = getVideoUpscaleRunner(model_name);
            if (!provider) throw new Error(`Video upscale model "${model_name}" not found in router.`);
        } else {
            const route = getUpscaleModel(model_name);
            provider = route?.i2i || null;
            if (!provider) throw new Error(`Image upscale model "${model_name}" not found in router.`);
        }

        // ─── Get workflow ───
        const workflow = await this.db.workflows.getWorkflow(finalWorkflowId);
        if (!workflow) {
            throw new Error(`Workflow ${finalWorkflowId} not found.`);
        }

        // ─── DB: Create generation config ───
        const config = await this.db.configs.createConfig({
            prompt: "",
            model: model_name,
            aspect_ratio: "LANDSCAPE",
            generation_type: "TEXT_BASE_IMAGE",
        });

        await this.db.configs.createReference({
            generation_config_id: config.id,
            position: 0,
            input_type: "IMAGE_INPUT_TYPE_BASE_IMAGE",
            ref_media_id: media_id,
        });

        // ─── Trigger background task ───
        console.log(`\n🚀 [UpscaleTreatment] Starting upscale for workflow:${finalWorkflowId} (${isVideo ? "video" : "image"})`);

        const context = { storageService: this.storageService, db: this.db };

        const runner = isVideo ? runVideoUpscaleTask : runUpscaleTask;
        runner(context, {
            provider,
            configId: config.id,
            workflow,
            upscaleScale,
            target_resolution,
            target_fps,
            userId,
            input_assets,
            startTime,
            project_id,
            session_id,
            model_name,
        }).catch((err) => {
            console.error(`❌ [UpscaleTreatment] Unhandled: ${err.message}`);
        });

        return {
            configId:  config.id,
            status:    "processing",
            mediaType: isVideo ? "video" : "image",
            provider:  `${model_name} → ${provider.constructor.name}`,
        };
    }
}
