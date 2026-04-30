import { getRunner, getModelName, EDIT_SUPPORT_MODELS } from "#video/core/modelRouter.js";
import { appendMediaToWorkflow, markMediaStatus, markMediaFailed } from "#db/workflowMediaOps.js";
import { verifyAndClampVideoParams        } from "#image/utils/treatmentUtils.js";
import { enqueueTreatmentJob } from "#queue/treatmentJob.js";

export class EditVideoTreatment {
    constructor({ promptService, storageService, db }) {
        this.promptService  = promptService;
        this.storageService = storageService;
        this.db             = db; 
    }

    getQueueType() {
        return this.constructor.name;
    }

    /**
     * prepare
     * Resolves workflow IDs into final media URLs and prepares the task descriptor.
     */
    async prepare(input) {
        const {
            video_workflow_id,      // ID of the video to edit
            reference_workflow_ids = [], // Array of workflow ID strings (No roles)
            prompt = "", model, ratio = "16:9", duration = "5s",
            project_id, session_id, userId,
            video_resolution, cfgScale, negativePrompt, multiPrompt, keepOriginalSound, sound
        } = input;

        // 1. Resolve Base Video
        const vWfId = video_workflow_id || input.workflow_id;
        if (!vWfId) throw new Error("video_workflow_id is required");

        const vMedia = await this.db.media.findLatestByWorkflow(vWfId);
        if (!vMedia || !vMedia.url) throw new Error(`Base video not ready for workflow ${vWfId}`);
        const video = vMedia.url;

        // 2. Resolve Reference Images (Simple ID Array)
        const references = [];
        for (const wfId of reference_workflow_ids) {
            const m = await this.db.media.findLatestByWorkflow(wfId);
            if (m?.url) {
                // Roles are removed, so we use a generic "reference" role
                references.push({ url: m.url, media_id: m.id, role: "reference", type: "image" });
            }
        }

        // Fallback for legacy references if IDs are missing
        if (references.length === 0 && input.references?.length) {
            for (const r of input.references) {
                if (r.url) references.push(r);
            }
        }

        // 3. Setup Model & Provider
        const mode = "v2v";
        let resolvedModel = model;
        let provider = getRunner(resolvedModel, mode);

        if (!provider) {
            resolvedModel = EDIT_SUPPORT_MODELS[0] || "kling_v3";
            provider = getRunner(resolvedModel, mode);
        }

        // 4. Verify Params
        const verified = verifyAndClampVideoParams(provider, { ratio, duration, cfgScale });

        // 5. Build Form (Sent to AI Provider)
        const form = {
            prompt, 
            model: resolvedModel,
            video, 
            references,
            ratio: verified.ratio,
            duration: verified.duration,
            resolution: video_resolution,
            cfgScale: verified.cfgScale,
            negativePrompt, multiPrompt, keepOriginalSound, sound
        };

        const model_name = getModelName(resolvedModel, mode);

        // 6. Persist Config & Placeholder
        const config = await this.db.configs.createConfig({
            prompt,
            model: model_name,
            aspect_ratio: verified.ratio,
            generation_type: "VIDEO_EDIT"
        });

        // Link base video
        await this.db.configs.createReference({
            generation_config_id: config.id,
            position: 0,
            input_type: "IMAGE_INPUT_TYPE_BASE_IMAGE",
            ref_media_id: vMedia.id
        });

        // Link references
        for (let i = 0; i < references.length; i++) {
            if (references[i].media_id) {
                await this.db.configs.createReference({
                    generation_config_id: config.id,
                    position: i + 1,
                    input_type: "IMAGE_INPUT_TYPE_REFERENCE",
                    ref_media_id: references[i].media_id
                });
            }
        }

        const workflow = await this.db.workflows.getWorkflow(vWfId);
        const media = await appendMediaToWorkflow(this.db, {
            workflow_id: workflow.id,
            mediaData: { 
                project_id, 
                generation_config_id: config.id, 
                step_id: "VID",
                width:  vMedia?.width  || 1280,
                height: vMedia?.height || 720
            },
            initialStatus: "processing"
        });

        return {
            video,       // Resolved URL
            references,  // Resolved URL array
            form, 
            mode, 
            configId: config.id,
            mediaId: media.id, 
            workflow,
            userId, project_id, session_id,
            model: resolvedModel,
            model_name,
            workflows: [workflow]
        };
    }

    /**
     * run
     */
    async run(task) {
        const { video, references, form, mode, model, mediaId, userId, workflow, model_name } = task;
        const startTime = Date.now();

        console.log(`\n🚀 [EditVideoTreatment] Starting BG Run | Video: ${video} | Refs: ${references.length}`);

        const provider = getRunner(model, mode);
        if (!provider) throw new Error(`Provider for ${model} not found`);

        try {
            if (form.prompt) {
                const safety = await this.promptService.checkPrompt(form.prompt);
                if (!safety.safe) {
                    await markMediaFailed(this.db, mediaId, safety.reason);
                    return;
                }
            }

            const adapted = provider.adapt(form, mode);
            const payload = provider.toPayload(adapted, mode);
            
            const executeMethod = provider.generate ? provider.generate.bind(provider) : provider.videoToVideo.bind(provider);
            const result = await executeMethod(payload, mode);

            const outputUrl = result.video_url || result.image_url;
            if (!outputUrl) throw new Error("Provider returned no output URL");

            const fileName = `${userId}/videos/${workflow.id}_edit_${Date.now()}.mp4`;
            const fileUrl  = await this.storageService.uploadFromUrl(fileName, outputUrl);

            await this.db.media.updateFields(mediaId, {
                url:    fileUrl,
                width:  result.width  || 1280,
                height: result.height || 720,
            });
            await markMediaStatus(this.db, mediaId, "success");

            console.log(`✅ [EditVideoTreatment] DONE | ${fileUrl}`);
            return { fileUrl, mediaId };

        } catch (error) {
            console.error(`❌ [EditVideoTreatment] Error:`, error.message);
            await markMediaFailed(this.db, mediaId, error);
            throw error;
        }
    }

    async runJob(task) {
        return this.run(task);
    }

    async execute(input) {
        const task = await this.prepare(input);
        const job = await enqueueTreatmentJob(this.getQueueType(), task);
        return {
            jobId: job.id,
            configId: task.configId,
            workflows: task.workflows,
            status: "queued",
            mode: task.mode,
            model: task.model_name,
        };
    }
}
