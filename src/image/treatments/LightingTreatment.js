import { getImageModel, ROUTED_IMAGE_MODELS } from "#image/core/modelRouter.js";
import { verifyAndClampParams } from "../utils/treatmentUtils.js";
import { appendMediaToWorkflow, markMediaStatus } from "#db/workflowMediaOps.js";
import { getStandardSize } from "#utils/sizeUtils.js";

export class LightingTreatment {
    constructor({ models, storageService, db }) {
        this.models = models;
        this.storageService = storageService;
        this.db = db;
    }

    _getStandardSize(ratio, quality) {
        return getStandardSize(ratio, quality);
    }

    _resolveProvider(model_name, references = []) {
        const route = getImageModel(model_name);
        const modelGroup = route?.group || this.models[model_name];

        if (!modelGroup && !route) {
            throw new Error(`Model "${model_name}" not found. Available: ${ROUTED_IMAGE_MODELS.join(", ")}`);
        }

        const isMulti = references.length > 1;
        const variantKey = references.length > 0 ? (isMulti ? "i2iMulti" : "i2i") : "t2i";

        const provider =
            route?.[variantKey] ||
            (references.length > 0 && route?.i2i) ||
            route?.t2i ||
            modelGroup?.[variantKey] ||
            modelGroup?.i2i ||
            modelGroup?.t2i ||
            modelGroup;

        if (!provider) throw new Error(`Provider not found for model "${model_name}"`);
        if (!["t2i", "i2i"].includes(provider.type)) {
            throw new Error(`Model "${model_name}" is a video model.`);
        }
        return provider;
    }

    async prepare(input) {
        let {
            angle, elevation, intensity, type, brightness, color,
            project_id, session_id, workflow_id,
            ratio, quality, model_name = "seedream-pro",
            negative_prompt, strength, steps, guidance_scale,
            seed, userId
        } = input;

        if (!workflow_id) throw new Error("workflow_id required for lighting edit");

        // ── Resolve source image from workflow ────────────────────────────────
        const sourceMedia = await this.db.media.findLatestByWorkflow(workflow_id);
        if (!sourceMedia)     throw new Error(`No media found for workflow ${workflow_id}`);
        if (!sourceMedia.url) throw new Error(`Source media has no final URL yet.`);

        // ── Build input_assets from URL only (no media_id) ───────────────────
        const input_assets = [{
            url:     sourceMedia.url,
            role:    "source",
            is_base: true,
        }];

        // ── Map lighting params to prompt ─────────────────────────────────────
        const lightType     = type === "hard" ? "sharp, hard directional light" : "soft, diffused ambient light";
        const colorDesc     = color && color !== "#ffffff" ? `with a ${color} color tint` : "with white natural light";
        const brightnessDesc = brightness <= 20 ? "very dim" : brightness <= 40 ? "low" : brightness <= 60 ? "moderate" : brightness <= 80 ? "bright" : "very bright";
        const intensityDesc  = intensity <= 2  ? "subtle"   : intensity <= 5   ? "moderate" : intensity <= 8 ? "strong" : "intense";

        let directionDesc = "";
        if      (elevation >  60) directionDesc = "overhead top-down light";
        else if (elevation >  30) directionDesc = "high-angle light from above";
        else if (elevation > -10) directionDesc = "eye-level side lighting";
        else if (elevation > -40) directionDesc = "low-angle light from below";
        else                      directionDesc = "dramatic under-lighting";

        const horizontalDir = angle < 45  ? "front"
                            : angle < 135 ? "right side"
                            : angle < 225 ? "back"
                            : angle < 315 ? "left side"
                            : "front";

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

        // ── Provider & params ─────────────────────────────────────────────────
        const provider = this._resolveProvider(model_name, input_assets);
        const verified  = verifyAndClampParams(provider, { steps, guidance_scale, ratio, quality, count: 1 });
        const sizeInfo  = this._getStandardSize(verified.ratio, verified.quality);

        // ── Config ────────────────────────────────────────────────────────────
        const generation_type = "TEXT_BASE_IMAGE_REFERENCES";
        const config = await this.db.configs.createConfig({
            prompt: lightingPrompt,
            model:  model_name,
            aspect_ratio: verified.ratio || "LANDSCAPE",
            generation_type,
        });

        // ── Workflow & media placeholder ──────────────────────────────────────
        const wf = await this.db.workflows.getWorkflow(workflow_id);
        if (!wf) throw new Error(`Workflow ${workflow_id} not found`);

        const media = await appendMediaToWorkflow(this.db, {
            workflow_id: wf.id,
            mediaData: {
                project_id,
                generation_config_id: config.id,
                step_id: "LIT",
                url:    null,
                width:  sizeInfo?.width  || 1024,
                height: sizeInfo?.height || 1024,
            },
            initialStatus: "processing",
        });

        return {
            userId, project_id, session_id, model_name,
            prompt: lightingPrompt, negative_prompt, generation_type,
            ratio: verified.ratio, quality: verified.quality,
            steps: verified.steps, guidance_scale: verified.guidance_scale,
            size: sizeInfo?.size, width: sizeInfo?.width, height: sizeInfo?.height,
            seed, input_assets, strength,
            configId: config.id,
            workflows: [wf],
            mediaIds:  [media.id],
        };
    }

    async run(task) {
        const {
            userId, model_name, prompt, negative_prompt, generation_type,
            ratio, quality, size, width, height, steps, guidance_scale,
            seed, strength, input_assets, configId, workflows, mediaIds,
        } = task;

        const provider = this._resolveProvider(model_name, input_assets);
        const sourceAsset = (input_assets || []).find(a => ["source", "normal", "start", "base"].includes(a.role)) || input_assets[0];
        const image_url = sourceAsset?.url || null;

        const workflow = workflows[0];
        const mediaId = mediaIds[0];

        try {
            const form = {
                prompt,
                negativePrompt: negative_prompt,
                negative_prompt,
                ratio, quality, size, width, height,
                steps: steps || 20,
                guidanceScale: guidance_scale || 7.5,
                guidance_scale: guidance_scale || 7.5,
                seed, strength,
                image: image_url,
                image_url,
                references: input_assets,
            };

            let payload;
            if (typeof provider.buildPayload === "function") payload = provider.buildPayload(form);
            else if (typeof provider.adapt === "function") {
                const adapted = provider.adapt(form);
                payload = provider.toPayload ? provider.toPayload(adapted) : adapted;
            } else payload = form;

            const result = await provider.generate(payload);
            const outputUrl = result.image_url || result.url;
            if (!outputUrl) throw new Error("Provider returned no output URL");

            const ext = "png";
            const fileName = `${userId}/generations/lighting_${workflow.id}_${Date.now()}.${ext}`;
            const fileUrl = await this.storageService.uploadFromUrl(fileName, outputUrl);

            const mediaConfig = await this.db.configs.createConfig({
                prompt, model: model_name, aspect_ratio: ratio, generation_type, seed: result.seed || seed || null,
            });

            await this.db.media.updateFields(mediaId, {
                generation_config_id: mediaConfig.id, url: fileUrl,
                width: result.width || width || 1024, height: result.height || height || 1024,
            });
            await markMediaStatus(this.db, mediaId, "success");

            return { configId, succeeded: 1, failed: 0 };
        } catch (err) {
            await markMediaStatus(this.db, mediaId, "failed", err.message);
            throw err;
        }
    }

    async execute(input) {
        const task = await this.prepare(input);
        this.run(task).catch(err => console.error(`[LightingTreatment] background error: ${err.message}`));
        return {
            batchId: null,
            configId: task.configId,
            workflows: task.workflows,
            status: "processing",
            provider: task.model_name,
        };
    }
}
