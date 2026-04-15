import { parseProviderError } from "../../errors/GenerationErrors.js";
import { appendMediaToWorkflow, markMediaStatus } from "../../db/workflowMediaOps.js";

export async function runVideoUpscaleTask(context, params) {
    const { storageService, db } = context;
    const {
        provider,
        configId,
        workflow,
        userId,
        input_assets,
        startTime,
        project_id,
        target_resolution,
        target_fps,
    } = params;

    console.log(`\n🎬 [VideoUpscaleTask] workflow:${workflow.id} | provider:${provider.constructor.name}`);

    const media = await appendMediaToWorkflow(db, {
        workflow_id: workflow.id,
        mediaData: {
            project_id,
            generation_config_id: configId,
            step_id: "UPSCALE",
            url: null,
            width: 1920,
            height: 1080,
        },
        initialStatus: "processing",
    });

    const sourceAsset = (input_assets || []).find((a) => a.is_base || a.role === "source");
    const video_url = sourceAsset?.url || null;
    if (!video_url) {
        await markMediaStatus(db, media.id, "failed", "Missing video_url");
        return;
    }

    let result;
    try {
        const adapted = provider.adapt({ video_url, target_resolution, target_fps });
        const payload = provider.toPayload(adapted);
        console.log("   ⚙️  [VideoUpscaleTask] Calling provider...");
        result = await provider.generate(payload);
        console.log("   ✅ [VideoUpscaleTask] Provider returned OK");
    } catch (err) {
        await markMediaStatus(db, media.id, "failed", parseProviderError(err).message);
        return;
    }

    const outputUrl = result.video_url || result.image_url;
    if (!outputUrl) {
        await markMediaStatus(db, media.id, "failed", "Provider returned no output URL");
        return;
    }

    try {
        const uniqueSuffix = Date.now() + Math.floor(Math.random() * 1000);
        const fileName = `${userId}/video_upscales/${workflow.id}_${uniqueSuffix}.mp4`;
        const fileUrl = await storageService.uploadFromUrl(fileName, outputUrl);

        await db.media.updateFields(media.id, {
            url: fileUrl,
            width: result.width || 1920,
            height: result.height || 1080,
        });
        await markMediaStatus(db, media.id, "success");

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`\n✅ [VideoUpscaleTask] Done in ${elapsed}s — workflow:${workflow.id} → media:${media.id}`);
    } catch (err) {
        await markMediaStatus(db, media.id, "failed", err.message);
    }
}
