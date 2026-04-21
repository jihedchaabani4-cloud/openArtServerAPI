import { ReferenceProcessor } from "#utils/ReferenceProcessor.js";
import { getUpscaleModel } from "#image/core/modelRouter.js";
import { getUpscaleRunner as getVideoUpscaleRunner } from "#video/core/modelRouter.js";
import { appendMediaToWorkflow, markMediaStatus, markMediaFailed } from "#db/workflowMediaOps.js";

export class UpscaleTreatment {
    constructor({ storageService, db }) {
        this.storageService = storageService;
        this.db = db;
        this.refProcessor = new ReferenceProcessor({ storageService, db });
    }

    _isVideoUrl(url = "") {
        const clean = String(url).split("?")[0].toLowerCase();
        return [".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv"].some((ext) => clean.endsWith(ext));
    }

    async prepare(input) {
        const {
            project_id, session_id, workflow_id,
            upscaleScale, target_resolution, target_fps, userId,
        } = input;

        let { media_id } = input;

        if (!project_id) throw new Error("project_id required");
        if (!session_id) throw new Error("session_id required");

        // ── Resolve Source Media ─────────────────────────────────────────────
        let sourceMedia = null;
        if (media_id) {
            sourceMedia = await this.db.media.findById(media_id);
        } else if (workflow_id) {
            sourceMedia = await this.db.workflows.getPrimaryMedia(workflow_id);
            media_id = sourceMedia?.id;
        }

        if (!sourceMedia) {
            throw new Error(`Could not resolve source media from media_id:"${media_id || 'none'}" or workflow_id:"${workflow_id || 'none'}"`);
        }

        const finalWorkflowId = workflow_id || sourceMedia.workflow_id;
        if (!finalWorkflowId) throw new Error("workflow_id could not be resolved.");

        const input_assets = await this.refProcessor.process(
            [{ url: sourceMedia.url, media_id, role: "source", is_base: true }],
            userId, project_id, session_id, "uploads"
        );
        const sourceAsset = input_assets[0];
        if (!sourceAsset || !sourceAsset.url) {
            throw new Error("Could not resolve source media URL for upscale.");
        }

        const isVideo = this._isVideoUrl(sourceAsset.url);
        const model_name = isVideo ? "topaz_video_upscale" : "topaz_image_upscale";

        const workflow = await this.db.workflows.getWorkflow(finalWorkflowId);
        if (!workflow) throw new Error(`Workflow ${finalWorkflowId} not found.`);

        const config = await this.db.configs.createConfig({
            prompt: "Upscale",
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

        const media = await appendMediaToWorkflow(this.db, {
            workflow_id: workflow.id,
            mediaData: {
                project_id,
                generation_config_id: config.id,
                step_id: isVideo ? "VID" : "CAE",
                url: null,
            },
            initialStatus: "processing",
        });

        return {
            userId, project_id, session_id,
            media_id, upscaleScale, target_resolution, target_fps,
            model_name, isVideo, input_assets,
            configId: config.id,
            workflows: [workflow],
            mediaIds: [media.id],
        };
    }

    async run(task) {
        const {
            userId, model_name, isVideo, input_assets, upscaleScale, target_resolution, target_fps,
            configId, workflows, mediaIds,
        } = task;

        const workflow = workflows[0];
        const mediaId = mediaIds[0];
        const sourceAsset = input_assets[0];

        let provider;
        if (isVideo) {
            provider = getVideoUpscaleRunner(model_name);
            if (!provider) throw new Error(`Video upscale model "${model_name}" not found.`);
        } else {
            const route = getUpscaleModel(model_name);
            provider = route?.i2i || null;
            if (!provider) throw new Error(`Image upscale model "${model_name}" not found.`);
        }

        try {
            console.log(`[UpscaleTreatment] workflow:${workflow.id} | calling provider (${provider.constructor.name})`);

            const form = {
                image: sourceAsset.url,
                video: sourceAsset.url,
                upscaleScale,
                target_resolution,
                target_fps,
                scale: upscaleScale,
            };

            let payload;
            if (typeof provider.buildPayload === "function") payload = provider.buildPayload(form);
            else if (typeof provider.adapt === "function") {
                const adapted = provider.adapt(form);
                payload = provider.toPayload ? provider.toPayload(adapted) : adapted;
            } else payload = form;

            const result = await provider.generate(payload);
            const outputUrl = result.image_url || result.video_url || result.url;
            if (!outputUrl) throw new Error("Provider returned no output URL");

            const ext = isVideo ? "mp4" : "png";
            const fileName = `${userId}/generations/upscaled_${workflow.id}_${Date.now()}.${ext}`;
            const fileUrl = await this.storageService.uploadFromUrl(fileName, outputUrl);

            await this.db.media.updateFields(mediaId, {
                url: fileUrl,
                width: result.width || null,
                height: result.height || null,
            });
            await markMediaStatus(this.db, mediaId, "success");

            console.log(`[UpscaleTreatment] run done | success`);
            return { configId, succeeded: 1, failed: 0 };
        } catch (err) {
            console.error(`[UpscaleTreatment] run failed | ${err.message}`);
            await markMediaFailed(this.db, mediaId, err);
            throw err;
        }
    }

    async execute(input) {
        const task = await this.prepare(input);
        this.run(task).catch(err => console.error(`[UpscaleTreatment] Background error: ${err.message}`));
        return {
            configId: task.configId,
            status: "processing",
            mediaType: task.isVideo ? "video" : "image",
            provider: task.model_name,
        };
    }
}
