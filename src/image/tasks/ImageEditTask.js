import { parseProviderError } from "../../errors/GenerationErrors.js";
import { appendMediaToWorkflow, markMediaStatus, markMediaFailed } from "../../db/workflowMediaOps.js";

/**
 * ImageEditTask — background task dedicated to editing an EXISTING workflow.
 *
 * Key differences from ImageGenerationTask:
 *  - No multi-shot / batch support (edits are always single-shot).
 *  - Does NOT create new workflows — adds a new media item to an existing wf.
 *  - Applies prompt-based localized editing when mask_selection is present.
 *  - Skips prompt enhancement so the user's edit intent is preserved verbatim.
 *  - Marks the new media as the workflow's primary_media_id.
 */
export async function runImageEditTask(context, params) {
    const { promptService, storageService, db } = context;
    const {
        provider,
        configId,
        workflow,         // single existing workflow object (not array)
        generation_type,
        prompt,
        negative_prompt,
        ratio, quality, size, width, height,
        userId, input_assets, image_base64,
        strength, startTime,
        steps, guidance_scale,
        seed, project_id, session_id,
        model_name,
        mask_selection,
        upscaleScale,
    } = params;

    console.log(`\n✏️  [ImageEditTask] workflow:${workflow.id} | provider:${provider.constructor.name}`);

    const sourceAsset = (input_assets || []).find(a => a.role === "source" || a.role === "normal" || a.is_base);
    const maskAsset   = (input_assets || []).find(a => a.role === "mask");
    const image_url   = sourceAsset?.url || image_base64 || null;
    const mask_url    = maskAsset?.url   || null;
    const media = await appendMediaToWorkflow(db, {
        workflow_id: workflow.id,
        mediaData: {
            project_id,
            generation_config_id: configId,
            step_id: "EDIT",
            url: null,
            width: width || 1024,
            height: height || 1024,
        },
        initialStatus: "processing",
    });

    // ─── STEP 1: Safety check ───
    let safety;
    try {
        safety = await promptService.checkPrompt(prompt);
    } catch (err) {
        console.error(`❌ [ImageEditTask] Safety check failed: ${err.message}`);
        await markMediaFailed(db, media.id, err);
        return;
    }
    if (!safety.safe) {
        console.error(`❌ [ImageEditTask] Prompt violation: ${safety.reason}`);
        await markMediaFailed(db, media.id, safety.reason);
        return;
    }

    // ─── STEP 2: Build final prompt ───
    // For edits, we use the raw prompt (no creative enhancement) to preserve intent.
    // We only generate a negative prompt for quality filtering.
    let finalPrompt = prompt;
    let finalNegative = negative_prompt || "";

    try {
        const autoNeg = await promptService.generateNegativePrompt(finalPrompt);
        finalNegative = [finalNegative, autoNeg || ""].filter(Boolean).join(", ");
    } catch (err) {
        console.warn(`⚠️ [ImageEditTask] Negative prompt generation failed: ${err.message}. Continuing without.`);
    }

    // ─── STEP 3: Localized Editing — inject bounding box into prompt ───
    if (mask_selection) {
        const { x, y, width: sw, height: sh, canvasWidth: cw, canvasHeight: ch } = mask_selection;
        if (cw > 0 && ch > 0) {
            const xmin = Math.min(1000, Math.max(0, Math.round((x / cw) * 1000)));
            const ymin = Math.min(1000, Math.max(0, Math.round((y / ch) * 1000)));
            const xmax = Math.min(1000, Math.max(0, Math.round(((x + sw) / cw) * 1000)));
            const ymax = Math.min(1000, Math.max(0, Math.round(((y + sh) / ch) * 1000)));

            finalPrompt += ` [at [${ymin}, ${xmin}, ${ymax}, ${xmax}]] edit this part`;
            console.log(`   🎯 [ImageEditTask] Localized edit coords: [${ymin}, ${xmin}, ${ymax}, ${xmax}]`);
        }
    }

    console.log(`   ✏️  Edit prompt: "${finalPrompt.substring(0, 100)}..."`);

    // ─── STEP 4: Build provider form ───
    const form = {
        prompt:         finalPrompt,
        negativePrompt: finalNegative,
        ratio,
        quality,
        size,
        width,
        height,
        seed,
        image:          image_url,
        image_url:      image_url,
        mask:           mask_url,
        mask_url:       mask_url,
        strength:       strength || 0.8,
        steps:          steps    || 20,
        guidanceScale:  guidance_scale || 7.5,
        references:     (input_assets || []).map(a => a.url),
        // Upscale specific
        ...(upscaleScale ? { scale: upscaleScale } : {}),
    };

    // ─── STEP 5: Call provider ───
    let result;
    try {
        const adapted = provider.adapt({ ...form });
        const payload = provider.toPayload(adapted);
        console.log(`   ⚙️  [ImageEditTask] Calling provider...`);
        result = await provider.generate(payload);
        console.log(`   ✅ [ImageEditTask] Provider returned OK`);
    } catch (err) {
        console.error(`❌ [ImageEditTask] Provider call failed: ${parseProviderError(err).message}`);
        await markMediaFailed(db, media.id, parseProviderError(err));
        return;
    }

    // ─── STEP 6: Upload result ───
    let fileUrl;
    try {
        const uniqueSuffix = Date.now() + Math.floor(Math.random() * 1000);
        const fileName = `${userId}/edits/${workflow.id}_${uniqueSuffix}.jpg`;
        console.log(`   ☁️  [ImageEditTask] Uploading...`);
        fileUrl = await storageService.upload(fileName, result.image_base64);
        console.log(`      ↳ ${fileUrl}`);
    } catch (err) {
        console.error(`❌ [ImageEditTask] Upload failed: ${err.message}`);
        await markMediaFailed(db, media.id, err);
        return;
    }

    // ─── STEP 7: Persist to DB ───
    try {
        // Per-media config for edit (stores the edited prompt w/ coords)
        const mediaConfig = await db.configs.createConfig({
            prompt:              finalPrompt,
            model:               model_name || "unknown",
            aspect_ratio:        ratio || "LANDSCAPE",
            generation_type,
            seed:                result.seed || null,
            media_generation_id: result.mediaGenerationId || null,
        });

        // Attach references to the media config
        for (let j = 0; j < (input_assets || []).length; j++) {
            const asset = input_assets[j];
            if (asset.media_id) {
                await db.configs.createReference({
                    generation_config_id: mediaConfig.id,
                    position:   j,
                    input_type: asset.is_base ? "IMAGE_INPUT_TYPE_BASE_IMAGE" : "IMAGE_INPUT_TYPE_REFERENCE",
                    ref_media_id: asset.media_id,
                });
            }
        }

        // Save new media item inside the EXISTING workflow
        await db.media.updateFields(media.id, {
            generation_config_id: mediaConfig.id,
            url: fileUrl,
            width: width || result.width || 1024,
            height: height || result.height || 1024,
        });
        await markMediaStatus(db, media.id, "success");

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n✅ [ImageEditTask] Done in ${elapsed}s — workflow:${workflow.id} → media:${media.id}`);
    } catch (dbErr) {
        console.error(`❌ [ImageEditTask] DB persist failed: ${dbErr.message}`);
        await markMediaFailed(db, media.id, dbErr);
    }
}
