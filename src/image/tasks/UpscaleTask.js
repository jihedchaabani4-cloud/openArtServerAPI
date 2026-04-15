import { parseProviderError } from "../../errors/GenerationErrors.js";
import { appendMediaToWorkflow, markMediaStatus } from "../../db/workflowMediaOps.js";

export async function runUpscaleTask(context, params) {
    const { storageService, db } = context;
    const {
        provider,
        configId,
        workflow,         
        upscaleScale,
        userId, input_assets,
        startTime,
        project_id, session_id,
        model_name,
    } = params;

    console.log(`\n🔍 [UpscaleTask] workflow:${workflow.id} | provider:${provider.constructor.name}`);

    const sourceAsset = (input_assets || []).find(a => a.is_base || a.role === "source");
    const image_url   = sourceAsset?.url || null;
    const media = await appendMediaToWorkflow(db, {
        workflow_id: workflow.id,
        mediaData: {
            project_id,
            generation_config_id: configId,
            step_id: "UPSCALE",
            url: null,
            width: 1024,
            height: 1024,
        },
        initialStatus: "processing",
    });

    if (!image_url) {
        console.error(`❌ [UpscaleTask] Missing image_url`);
        await markMediaStatus(db, media.id, "failed", "Missing image_url");
        return;
    }

    // ─── STEP 1: Build provider form ───
    const form = {
        image:     image_url,
        image_url: image_url,
        scale:     upscaleScale || "x4",
    };

    // ─── STEP 2: Call provider ───
    let result;
    try {
        const adapted = provider.adapt({ ...form });
        const payload = provider.toPayload(adapted);
        console.log(`   ⚙️  [UpscaleTask] Calling provider...`);
        result = await provider.generate(payload);
        console.log(`   ✅ [UpscaleTask] Provider returned OK`);
    } catch (err) {
        console.error(`❌ [UpscaleTask] Provider call failed: ${parseProviderError(err).message}`);
        await markMediaStatus(db, media.id, "failed", parseProviderError(err).message);
        return;
    }

    // ─── STEP 3: Upload result ───
    let fileUrl;
    try {
        const uniqueSuffix = Date.now() + Math.floor(Math.random() * 1000);
        const fileName = `${userId}/upscales/${workflow.id}_${uniqueSuffix}.jpg`;
        console.log(`   ☁️  [UpscaleTask] Uploading...`);
        fileUrl = await storageService.upload(fileName, result.image_base64);
        console.log(`      ↳ ${fileUrl}`);
    } catch (err) {
        console.error(`❌ [UpscaleTask] Upload failed: ${err.message}`);
        await markMediaStatus(db, media.id, "failed", err.message);
        return;
    }

    // ─── STEP 4: Persist to DB ───
    try {
        // Save new media item inside the EXISTING workflow
        await db.media.updateFields(media.id, {
            generation_config_id: configId,
            url: fileUrl,
            width: result.width || 1024,
            height: result.height || 1024,
        });
        await markMediaStatus(db, media.id, "success");

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n✅ [UpscaleTask] Done in ${elapsed}s — workflow:${workflow.id} → media:${media.id}`);
    } catch (dbErr) {
        console.error(`❌ [UpscaleTask] DB persist failed: ${dbErr.message}`);
        await markMediaStatus(db, media.id, "failed", dbErr.message);
    }
}
