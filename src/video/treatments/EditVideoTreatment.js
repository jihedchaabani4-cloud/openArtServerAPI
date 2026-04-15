import { ReferenceProcessor } from "#utils/ReferenceProcessor.js";
import { getRunner, getModelName, EDIT_SUPPORT_MODELS } from "#video/core/modelRouter.js";
import { appendMediaToWorkflow, markMediaStatus } from "#db/workflowMediaOps.js";
import { CameraTask } from "#video/tasks/CameraTask.js"; // [Removed] No longer needed

// EditVideoTreatment — exclusively video-to-video editing
const executeV2V = (p, payload, mode) =>
    p.generate ? p.generate(payload, mode) : p.videoToVideo(payload);

export class EditVideoTreatment {
    constructor({ promptService, storageService, db }) {
        this.promptService  = promptService;
        this.storageService = storageService;
        this.db             = db; 
        this.refProcessor   = new ReferenceProcessor({ storageService, db });
    }

    async execute(input) {
        const {
            model,
            prompt            = "",
            ratio             = "16:9",
            duration          = "5s",
            project_id,
            session_id,
            workflow_id,
            media_id,
            sound,
            cfgScale,
            negativePrompt    = "",
            multiPrompt,
            keepOriginalSound,
            video_resolution,
            camera_control,
            cameraControl,
            edit_type,
        } = input;

        let references = input.references || [];
        const userId    = input.userId || input.user_id;
        const startTime = Date.now();

        // ── Step 0: Log incoming request ─────────────────────────────────────
        console.log(`\n${"─".repeat(60)}`);
        console.log(`📥 [EditVideoTreatment] New ${edit_type || "edit"} request`);
        console.log(`   model:       ${model || "(auto)"}`);
        console.log(`   edit_type:   ${edit_type || "edit"}`);
        console.log(`   workflow_id: ${workflow_id}`);
        console.log(`   media_id:    ${media_id}`);
        console.log(`   prompt:      "${prompt}"`);
        if (input.camera_text)
        console.log(`   camera_text: "${input.camera_text}"`);
        console.log(`   references:  ${references.length} item(s)`);
        console.log(`${"─".repeat(60)}`);

        if (!project_id) throw new Error("project_id required");
        if (!session_id) throw new Error("session_id required");
        if (!workflow_id) throw new Error("workflow_id required for editing/extending video");

        // ── Step 1: Inject media_id as base video reference ──────────────────
        if (media_id && !references.find(r => r.media_id === media_id || r.asset_id === media_id)) {
            references.unshift({ media_id, role: "video", type: "video" });
            console.log(`   ✅ [Step 1] Injected media_id "${media_id}" as base video reference`);
        } else {
            console.log(`   ✅ [Step 1] media_id already in references or not provided`);
        }

        // ── Step 2: Resolve model + provider ─────────────────────────────────
        const mode = "v2v";
        let resolvedModel = model;
        let provider = getRunner(resolvedModel, mode);

        if (!provider) {
            const fallback = EDIT_SUPPORT_MODELS[0];
            if (!fallback) throw new Error(`[EditVideoTreatment] No models available that support video editing.`);
            console.warn(`   ⚠️  [Step 2] Model "${model}" not supported. Falling back to "${fallback}"`);
            resolvedModel = fallback;
            provider = getRunner(resolvedModel, mode);
        } else {
            console.log(`   ✅ [Step 2] Provider resolved → "${resolvedModel}" (mode: ${mode})`);
        }

        if (!provider) throw new Error(`[EditVideoTreatment] Fallback model "${resolvedModel}" also failed.`);

        // ── Step 3: Upload / resolve references ──────────────────────────────
        const maxRefs  = provider.maxReferences ?? 1;
        const rawRefs  = references.slice(0, maxRefs);
        console.log(`   ✅ [Step 3] Processing ${rawRefs.length}/${references.length} reference(s) (maxRefs: ${maxRefs})`);

        const input_assets = await this.refProcessor.process(
            rawRefs, userId, project_id, session_id, "video_uploads"
        );
        const resolvedRefs = rawRefs.map((ref, i) => ({
            ...ref,
            url: input_assets[i]?.url || ref.url,
        }));

        const baseVideoRef  = resolvedRefs.find(r => r.media_id === media_id) || resolvedRefs.find(r => r.type === "video");
        const remainingRefs = resolvedRefs.filter(r => r !== baseVideoRef);

        console.log(`   ✅ [Step 3] Base video URL: ${baseVideoRef?.url || "(none)"}`);
        console.log(`   ✅ [Step 3] Extra refs:     ${remainingRefs.length} item(s)`);

        // ── Step 4: Camera edit → Setup final prompt ─────────────────────────────
        let finalPrompt        = prompt;
        let finalCameraControl = cameraControl || camera_control || undefined;

        console.log(`   ✅ [Step 4] Executing edit with prompt: "${finalPrompt}"`);
        if (finalCameraControl) {
            console.log(`   ✅ [Step 4] Using provided cameraControl: ${JSON.stringify(finalCameraControl)}`);
        }

        // ── Step 5: Build form ────────────────────────────────────────────────
        const form = {
            prompt: finalPrompt, model: resolvedModel, ratio,
            duration:      parseFloat(String(duration)) || 5,
            resolution:    video_resolution,
            sound, cfgScale, negativePrompt, multiPrompt, keepOriginalSound,
            cameraControl: finalCameraControl,
            video:         baseVideoRef?.url,
            references:    remainingRefs,
            edit_type,
        };
        const model_name = getModelName(resolvedModel, mode);
        console.log(`\n   ✅ [Step 5] Form built | model_name: "${model_name}" | duration: ${form.duration}s | ratio: ${form.ratio}`);

        // ── Step 6: Persist generation config ────────────────────────────────
        const config = await this.db.configs.createConfig({
            prompt: finalPrompt,
            model:  model_name,
            aspect_ratio:    ratio || "16:9",
            generation_type: input_assets.length > 0 ? "VIDEO_REFERENCES" : "TEXT_ONLY",
        });
        console.log(`   ✅ [Step 6] Config created → id: ${config.id}`);

        for (let i = 0; i < input_assets.length; i++) {
            const asset = input_assets[i];
            if (asset.media_id) {
                await this.db.configs.createReference({
                    generation_config_id: config.id,
                    position:    i,
                    input_type:  "VIDEO_INPUT_TYPE_BASE_VIDEO",
                    ref_media_id: asset.media_id,
                });
                console.log(`   ✅ [Step 6] Reference attached: media_id=${asset.media_id} (pos ${i})`);
            }
        }

        // ── Step 7: Load workflow ─────────────────────────────────────────────
        const workflow = await this.db.workflows.getWorkflow(workflow_id);
        if (!workflow) throw new Error(`Workflow ${workflow_id} not found`);
        console.log(`   ✅ [Step 7] Workflow loaded → id: ${workflow.id}`);

        // ── Step 8: Fire background job ──────────────────────────────────────
        console.log(`\n🚀 [EditVideoTreatment] Dispatching background job... (edit_type: ${edit_type})`);

        this._runBackground({
            provider, form, mode,
            batchId:  null,
            configId: config.id,
            workflow,
            input_assets,
            userId, project_id, session_id, startTime,
            model_name,
        }).catch(err => {
            console.error(`❌ [EditVideoTreatment] Background Error: ${err.message || err}`);
        });

        return {
            batchId:   null,
            configId:  config.id,
            workflows: [workflow],
            status:    "processing",
            mode,
            model:     model_name,
            edit_type,
        };
    }

    async _runBackground({
        provider, form, mode,
        batchId, configId, workflow,
        input_assets,
        userId, project_id, session_id, startTime,
        model_name,
    }) {
        console.log(`\n⚙️  [EditVideoTreatment][BG] Starting background execution...`);

        const media = await appendMediaToWorkflow(this.db, {
            workflow_id: workflow.id,
            mediaData: {
                project_id,
                generation_config_id: configId,
                step_id: "CAE",
                url:    null,
                width:  1280,
                height: 720,
            },
            initialStatus: "processing",
        });
        console.log(`   ✅ [BG] Media placeholder created → id: ${media.id}`);

        // Safety check
        if (form.prompt) {
            console.log(`   🔍 [BG] Checking prompt safety...`);
            const safety = await this.promptService.checkPrompt(form.prompt);
            if (!safety.safe) {
                console.warn(`   ❌ [BG] Prompt rejected: ${safety.reason}`);
                await markMediaStatus(this.db, media.id, "failed", safety.reason);
                return;
            }
            console.log(`   ✅ [BG] Prompt safe`);
        }

        // Adapt + payload
        const adapted = provider.adapt(form, mode);
        const payload = provider.toPayload(adapted, mode);
        const runner  = (provider.variants && provider.variants[mode]) || provider;

        console.log(`   🌐 [BG] Calling provider API: ${runner.modelName || model_name}`);
        console.log(`   📦 [BG] Payload: ${JSON.stringify(payload, null, 2)}`);

        const result    = await executeV2V(provider, payload, mode);
        const outputUrl = result.video_url || result.image_url;

        if (!outputUrl) {
            console.error(`   ❌ [BG] Provider returned no output URL`);
            await markMediaStatus(this.db, media.id, "failed", "Provider returned no output URL");
            throw new Error("Provider returned no output URL");
        }

        console.log(`   ✅ [BG] Provider returned URL: ${outputUrl}`);

        // Upload to storage
        const fileName = `${userId}/videos/${batchId || workflow.id}_edit_${Date.now()}.mp4`;
        const fileUrl  = await this.storageService.uploadFromUrl(fileName, outputUrl);
        console.log(`   ✅ [BG] Uploaded to storage: ${fileUrl}`);

        // Update media record
        const mediaConfig = await this.db.configs.createConfig({
            prompt:          form.prompt,
            model:           model_name,
            aspect_ratio:    form.ratio || "16:9",
            generation_type: input_assets.length > 0 ? "VIDEO_REFERENCES" : "TEXT_ONLY",
            seed:            result.seed || null,
        });

        await this.db.media.updateFields(media.id, {
            generation_config_id: mediaConfig.id,
            url:    fileUrl,
            width:  result.width  || 1280,
            height: result.height || 720,
        });
        await markMediaStatus(this.db, media.id, "success");

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n✅ [EditVideoTreatment][BG] DONE in ${elapsed}s | media.id: ${media.id}`);
        console.log(`${"─".repeat(60)}\n`);
    }
}
