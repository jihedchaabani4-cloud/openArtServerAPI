import { Errors, parseProviderError } from "../../errors/GenerationErrors.js";
import { appendMediaToWorkflow, markMediaStatus } from "../../db/workflowMediaOps.js";

/**
 * Runs in the background (fire-and-forget).
 * For each variation (workflow), calls the provider, uploads the result,
 * saves a media record, and updates workflow.primary_media_id.
 */
export async function runImageGenerationTask(context, params) {
    const { promptService, storageService, db } = context;
    const {
        provider,
        batchId, configId, workflows,
        generation_type,
        prompt, negative_prompt,
        ratio, quality, size, width, height,
        userId, input_assets, image_base64,
        strength, startTime,
        steps, guidance_scale,
        seed, project_id, session_id,
        model_name, count = 1,
    } = params;

    console.log(`\n⚙️  [ImageGenerationTask] ${batchId ? `batch:${batchId}` : 'single'} | ${count} variation(s) | provider:${provider.constructor.name}`);

    const sourceAsset = (input_assets || []).find(a => a.role === "source" || a.role === "normal" || a.role === "start");
    const maskAsset   = (input_assets || []).find(a => a.role === "mask");
    const image_url   = sourceAsset?.url || image_base64 || null;
    const mask_url    = maskAsset?.url   || null;

    // ─── STEP 1: Safety check ───
    let safety;
    try {
        safety = await promptService.checkPrompt(prompt);
    } catch (err) {
        console.error(`❌ Safety check failed: ${err.message}`);
        return;
    }
    if (!safety.safe) {
        console.error(`❌ Prompt violation: ${safety.reason}`);
        return;
    }

    // ─── STEP 2: Enhance prompt ───
    let finalPrompt, finalNegative;
    try {
        const enhanced = await promptService.upscalePrompt(prompt, { quality });
        finalPrompt    = enhanced.enhanced;
        const autoNeg  = await promptService.generateNegativePrompt(finalPrompt);
        finalNegative  = [negative_prompt || "", autoNeg || ""].filter(Boolean).join(", ");
        console.log(`   ✏️  Prompt: "${finalPrompt.substring(0, 80)}..."`);
    } catch (err) {
        console.error(`❌ Prompt enhance failed: ${err.message}`);
        return;
    }

    // ─── Base form for provider ───
    const form = {
        prompt:         finalPrompt,
        negativePrompt: finalNegative,
        ratio, quality, size, width, height, seed,
        image:          image_url,
        image_url:      image_url,
        mask:           mask_url,
        mask_url:       mask_url,
        strength:       strength || 0.8,
        steps:          steps    || 20,
        guidanceScale:  guidance_scale || 7.5,
        references:     (input_assets || []).map(a => a.url),
    };

    // ─── Multi-shot (native batch from provider) ───
    if (count > 1 && provider.textToImageMulti && !image_url) {
        try {
            const multi = await provider.textToImageMulti({ ...form, shots: count });

            for (let i = 0; i < (multi.items || []).length; i++) {
                const shot = multi.items[i];
                const wf   = workflows[i];
                if (!wf) break;
                let media = null;

                try {
                    media = await appendMediaToWorkflow(db, {
                        workflow_id: wf.id,
                        mediaData: {
                            project_id,
                            generation_config_id: configId,
                            step_id: "CAE",
                            url: null,
                            width: width || 1024,
                            height: height || 1024,
                        },
                        initialStatus: "processing",
                    });

                    const uniqueSuffix = Date.now() + Math.floor(Math.random() * 1000);
                    const fileName  = `${userId}/generations/${batchId || wf.id}_${i + 1}_${uniqueSuffix}.jpg`;
                    const fileUrl   = await storageService.upload(fileName, shot.image_base64);

                    // Per-media config (with seed)
                    const mediaConfig = await db.configs.createConfig({
                        prompt:      finalPrompt,
                        model:       model_name || "unknown",
                        aspect_ratio: ratio || "LANDSCAPE",
                        generation_type,
                        seed:        shot.seed || null,
                        media_generation_id: shot.mediaGenerationId || null,
                    });

                    // ── Connect references to this new media config ──
                    for (let j = 0; j < (input_assets || []).length; j++) {
                        const asset = input_assets[j];
                        if (asset.media_id) {
                            await db.configs.createReference({
                                generation_config_id: mediaConfig.id,
                                position: j,
                                input_type: asset.is_base ? "IMAGE_INPUT_TYPE_BASE_IMAGE" : "IMAGE_INPUT_TYPE_REFERENCE",
                                ref_media_id: asset.media_id,
                            });
                        }
                    }

                    await db.media.updateFields(media.id, {
                        generation_config_id: mediaConfig.id,
                        url: fileUrl,
                        width: width || 1024,
                        height: height || 1024,
                    });
                    await markMediaStatus(db, media.id, "success");

                    console.log(`   ✅ [${i + 1}/${count}] workflow:${wf.id} → media:${media.id}`);
                } catch (uploadErr) {
                    console.error(`❌ Upload failed for variation ${i + 1}: ${uploadErr.message}`);
                    if (media?.id) await markMediaStatus(db, media.id, "failed", uploadErr.message);
                }
            }
            console.log(`✅ [ImageGenerationTask] Multi-shot batch done: ${batchId}`);
            return;

        } catch (err) {
            console.error(`❌ Multi-shot failed: ${parseProviderError(err).message}`);
            return;
        }
    }

    // ─── Single-shot loop (one call per variation) ───
    for (let i = 0; i < workflows.length; i++) {
        const wf = workflows[i];
        let media = null;

        media = await appendMediaToWorkflow(db, {
            workflow_id: wf.id,
            mediaData: {
                project_id,
                generation_config_id: configId,
                step_id: "CAE",
                url: null,
                width: width || 1024,
                height: height || 1024,
            },
            initialStatus: "processing",
        });

        // STEP 3: Call provider
        let result;
        try {
            const adapted = provider.adapt({ ...form, index: i });
            const payload = provider.toPayload(adapted);
            console.log(`\n   ⚙️  [${i + 1}/${count}] Calling provider...`);
            result = await provider.generate(payload);
            console.log(`   ✅ [${i + 1}/${count}] Provider returned OK`);
        } catch (err) {
            console.error(`❌ Generation failed for variation ${i + 1}: ${parseProviderError(err).message}`);
            await markMediaStatus(db, media.id, "failed", parseProviderError(err).message);
            continue;
        }

        // STEP 4: Upload + DB
        try {
            const uniqueSuffix = Date.now() + Math.floor(Math.random() * 1000);
            const fileName = `${userId}/generations/${batchId || wf.id}_${i + 1}_${uniqueSuffix}.jpg`;
            console.log(`   ☁️  [${i + 1}/${count}] Uploading...`);
            const fileUrl  = await storageService.upload(fileName, result.image_base64);
            console.log(`      ↳ ${fileUrl}`);

            // Per-media config (with seed from provider result)
            const mediaConfig = await db.configs.createConfig({
                prompt:          finalPrompt,
                model:           model_name || "unknown",
                aspect_ratio:    ratio || "LANDSCAPE",
                generation_type,
                seed:            result.seed || null,
                media_generation_id: result.mediaGenerationId || null,
            });

            // ── Connect references to this new media config ──
            for (let j = 0; j < (input_assets || []).length; j++) {
                const asset = input_assets[j];
                if (asset.media_id) {
                    await db.configs.createReference({
                        generation_config_id: mediaConfig.id,
                        position: j,
                        input_type: asset.is_base ? "IMAGE_INPUT_TYPE_BASE_IMAGE" : "IMAGE_INPUT_TYPE_REFERENCE",
                        ref_media_id: asset.media_id,
                    });
                }
            }

            await db.media.updateFields(media.id, {
                generation_config_id: mediaConfig.id,
                url: fileUrl,
                width: width || result.width || 1024,
                height: height || result.height || 1024,
            });
            await markMediaStatus(db, media.id, "success");

            console.log(`   ✅ [${i + 1}/${count}] media:${media.id} saved`);
        } catch (uploadErr) {
            console.error(`❌ Upload/DB failed for variation ${i + 1}: ${uploadErr.message}`);
            await markMediaStatus(db, media.id, "failed", uploadErr.message);
            continue;
        }
    }

    console.log(`\n✅ [ImageGenerationTask] Done: batch ${batchId}`);
}
