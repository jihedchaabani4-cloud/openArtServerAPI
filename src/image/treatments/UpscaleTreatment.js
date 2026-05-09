import { ReferenceProcessor } from "#utils/ReferenceProcessor.js";
import { calculateUpscaleCredits, getUpscaleModel } from "#image/core/modelRouter.js";
import { getUpscaleRunner as getVideoUpscaleRunner } from "#video/core/modelRouter.js";
import { appendMediaToWorkflow, markMediaStatus, markMediaFailed } from "#db/workflowMediaOps.js";
import { enqueueTreatmentJob } from "#queue/treatmentJob.js";
import { skipIfMediaAlreadyDone } from "#utils/skipIfMediaAlreadyDone.js";

export class UpscaleTreatment {
    static DEFAULT_MODEL = "topaz_image_upscale";

    constructor({ storageService, db, walletService = null }) {
        this.storageService = storageService;
        this.db = db;
        this.walletService = walletService;
        this.refProcessor = new ReferenceProcessor({ storageService, db });
    }

    _isVideoUrl(url = "") {
        const clean = String(url).split("?")[0].toLowerCase();
        return [".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv"].some((ext) => clean.endsWith(ext));
    }

    getQueueType() {
        return this.constructor.name;
    }

    async prepare(input) {
        const {
            project_id, session_id, workflow_id,
            upscaleScale, target_resolution, target_fps, userId,
        } = input;

        let { media_id } = input;

        if (!project_id) throw new Error("project_id required");

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

        // ── Check Wallet Balance before DB writes ───────────────────────────
        let holdAmount = 0;
        let pricingDetails = null;
        if (this.walletService && userId) {
            pricingDetails = calculateUpscaleCredits({
                modelKey: model_name || "topaz_image_upscale",
                upscaleScale: upscaleScale || 2,
            });
            holdAmount = pricingDetails.credits;

            if (holdAmount > 0) {
                await this.walletService.checkSufficientFunds(userId, holdAmount);
            }
        }

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
                step_id: "UP",
                url: null,
                width: sourceMedia?.width || 1024,
                height: sourceMedia?.height || 1024,
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
            // Pricing and wallet state
            walletHoldAmount: holdAmount,
            pricingDetails,
        };
    }

    async runJob(task) {
        try {
            const mediaId = task.mediaIds?.[0];
            const duplicateSkip = await skipIfMediaAlreadyDone(this.db, mediaId);
            if (duplicateSkip) {
                if (this.walletService && task.walletReferenceId) {
                    await this.walletService.commitHoldIdempotent(task.walletReferenceId);
                }
                return duplicateSkip;
            }

            const result = await this.run(task);

            if (this.walletService && task.walletReferenceId) {
                await this.walletService.commitHoldIdempotent(task.walletReferenceId);
            }

            return result;
        } catch (error) {
            if (this.walletService && task.walletReferenceId) {
                try {
                    await this.walletService.rollback(task.walletReferenceId);
                } catch (walletError) {
                    console.error(`[UpscaleTreatment] wallet rollback failed for ${task.walletReferenceId}: ${walletError.message}`);
                }
            }

            throw error;
        }
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
        let task;
        try {
            task = await this.prepare(input);
        } catch (error) {
            throw error;
        }

        const userId = input?.userId || input?.user_id;
        const shouldHoldCredits =
            !!this.walletService &&
            !!userId &&
            !!task?.configId &&
            (task.walletHoldAmount > 0);

        let walletReferenceId = null;

        if (shouldHoldCredits) {
            walletReferenceId = task.configId;

            await this.walletService.hold({
                userId: userId,
                amount: task.walletHoldAmount,
                referenceId: walletReferenceId,
                metadata: {
                    treatment: this.getQueueType(),
                    media_id: task.media_id || input?.media_id || null,
                    project_id: task.project_id || input?.project_id || null,
                    session_id: task.session_id || input?.session_id || null,
                    workflow_id: task.workflows?.[0]?.id || input?.workflow_id || null,
                    upscaleScale: task.upscaleScale || input?.upscaleScale || null,
                    pricingVersion: task.pricingDetails?.pricingVersion,
                    pricingBreakdown: task.pricingDetails?.breakdown,
                },
            });

            const wallet = await this.walletService.getWalletOrThrow(userId);
            task.remainingBalance = wallet.balance;
        }

        if (walletReferenceId) {
            task.walletReferenceId = walletReferenceId;
        }

        let job;
        try {
            job = await enqueueTreatmentJob(
                this.getQueueType(),
                task,
                walletReferenceId ? { jobId: walletReferenceId } : {}
            );
        } catch (error) {
            if (this.walletService && walletReferenceId) {
                try {
                    await this.walletService.rollback(walletReferenceId);
                } catch (walletError) {
                    console.error(`[UpscaleTreatment] wallet rollback after enqueue failure failed for ${walletReferenceId}: ${walletError.message}`);
                }
            }
            throw error;
        }

        return {
            jobId: job.id,
            configId: task.configId,
            status: "queued",
            mediaType: task.isVideo ? "video" : "image",
            provider: task.model_name,
            balance: task.remainingBalance ?? null,
        };
    }
}
