import { Router } from "express";
import multer from "multer";
import { db, storageService } from "../src/container.js";
import { extractMediaMetadata } from "../src/utils/MediaMetadataExtractor.js";
import { supabase } from "../lib/supabase.js";
import { createWorkflowWithMedia, markMediaStatus } from "../src/db/workflowMediaOps.js";
import { requireAuth } from "../src/middleware/auth.js";
import { autoCreateProjectAndSession } from "../lib/helpers.js";

const router = Router();
router.use(requireAuth);

// ─── Multer ────────────────────────────────────────────────────────────────
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
    fileFilter: (req, file, cb) => {
        const allowed = [
            "image/jpeg", "image/png", "image/webp", "image/gif",
            "video/mp4", "video/webm", "video/quicktime",
        ];
        if (allowed.includes(file.mimetype)) cb(null, true);
        else cb(new Error(`Unsupported file type: ${file.mimetype}`));
    },
});

// ─── Helpers ───────────────────────────────────────────────────────────────

function extFromMime(mime) {
    const map = {
        "image/jpeg":     "jpg",
        "image/png":      "png",
        "image/webp":     "webp",
        "image/gif":      "gif",
        "video/mp4":      "mp4",
        "video/webm":     "webm",
        "video/quicktime":"mov",
    };
    return map[mime] || "bin";
}

function mimeFromBase64Header(dataUri) {
    const match = dataUri.match(/^data:([^;]+);base64,/);
    return match ? match[1] : "image/jpeg";
}

async function uploadBufferToStorage({ buffer, mime, userId, projectId }) {
    const isVideo = mime.startsWith("video/");
    const folder  = isVideo ? "video_uploads" : "uploads";
    const ext     = extFromMime(mime);
    const path    = `${userId}/${folder}/${Date.now()}_asset.${ext}`;
    const publicUrl = await storageService.upload(path, buffer);
    return { publicUrl, path, isVideo, mime };
}

function validateMedia(metadata, mime) {
    const isVideo = mime.startsWith("video/");
    const isImage = mime.startsWith("image/");

    if (isImage) {
        // Image Max Size: 10MB
        const MAX_IMAGE_SIZE = 10 * 1024 * 1024;
        if (metadata.file_size > MAX_IMAGE_SIZE) {
            throw new Error(`Image is too large (${metadata.file_size_label}). Max allowed is 0.2MB.`);
        }
    }

    if (isVideo) {
        // Video Max Duration: 30 seconds
        const MAX_VIDEO_DURATION = 30;
        if (metadata.duration_sec && metadata.duration_sec > MAX_VIDEO_DURATION) {
            throw new Error(`Video is too long (${metadata.duration_label}). Max allowed is 30s.`);
        }

        // Video Max Resolution: 200 Megapixels (w * h)
        const MAX_PIXELS = 200 * 1000 * 1000;
        if (metadata.width && metadata.height) {
            const pixels = metadata.width * metadata.height;
            if (pixels > MAX_PIXELS) {
                const mp = (pixels / 1000000).toFixed(1);
                throw new Error(`Video resolution is too high (${mp}MP). Max allowed is 200MP.`);
            }
        }
    }
}

// ─── POST /api/assets/upload ───────────────────────────────────────────────
router.post("/upload", upload.single("file"), async (req, res) => {
    try {
        const userId    = req.user.id;
        let projectId = req.body?.project_id || null;
        let sessionId = req.body?.session_id || null;

        if (!projectId) {
            return res.status(400).json({
                ok: false,
                error: "project_id is required for asset uploads.",
            });
        }

        const { data: ownedProject, error: projectErr } = await supabase
            .from("project")
            .select("id, user_id")
            .eq("id", projectId)
            .single();

        if (projectErr || !ownedProject) {
            return res.status(404).json({
                ok: false,
                error: "Project not found.",
            });
        }

        if (ownedProject.user_id !== userId) {
            return res.status(403).json({
                ok: false,
                error: "You are not allowed to upload assets to this project.",
            });
        }

        // Ensure session exists
        const ensured = await autoCreateProjectAndSession(userId, projectId, sessionId);
        projectId = ensured.project_id;
        sessionId = ensured.session_id;

        let buffer, mime;

        if (req.file) {
            buffer = req.file.buffer;
            mime   = req.file.mimetype;
        } else if (req.body?.base64) {
            const raw = req.body.base64;
            mime      = req.body.mime_type || mimeFromBase64Header(raw);
            const pureBase64 = raw.includes(",") ? raw.split(",")[1] : raw;
            buffer   = Buffer.from(pureBase64, "base64");
        } else {
            return res.status(400).json({ ok: false, error: "No file or base64 provided." });
        }

        let bodyMeta = null;
        if (req.body.metadata) {
            try { bodyMeta = JSON.parse(req.body.metadata); } catch(e) {}
        }
        
        // Extract dimensions from buffer
        const metadata = await extractMediaMetadata(buffer, mime);
        console.log(`🔍 [AssetsRoute] Extracted Meta:`, JSON.stringify(metadata));

        // Security / Policy Validation
        try {
            validateMedia(metadata, mime);
        } catch (validationErr) {
            return res.status(400).json({ ok: false, error: validationErr.message });
        }

        const width  = metadata?.width  || bodyMeta?.width  || 1024;
        const height = metadata?.height || bodyMeta?.height || 1024;
        const ratio  = metadata?.ratio  || bodyMeta?.ratio  || "1:1";
        const resolution = metadata?.resolution || bodyMeta?.resolution || null;
        const size   = metadata?.size   || bodyMeta?.size   || null;

        // 1. Create workflow + media record immediately with status=processing
        //    (URL is null at this point — will be updated after storage upload)
        const isVideo = mime.startsWith("video/");
        const { workflow: wf, media: mediaRecord } = await createWorkflowWithMedia(db, {
            workflowData: {
                project_id:      projectId,
                session_id:      sessionId,
                display_name:    req.file?.originalname || "Upload",
                variation_index: null,
            },
            mediaData: {
                project_id:           projectId,
                generation_config_id: null,
                step_id:              "upload",
                url:                  null,
                width:                width,
                height:               height,
            },
            initialStatus: "processing",
        });

        console.log(`📤 [AssetsRoute] Media record created (processing) → media:${mediaRecord.id}, workflow:${wf.id}`);

        // 2. Upload file to storage
        let publicUrl;
        try {
            const uploaded = await uploadBufferToStorage({ buffer, mime, userId, projectId });
            publicUrl = uploaded.publicUrl;
        } catch (storageErr) {
            await markMediaStatus(db, mediaRecord.id, "failed", storageErr.message);
            throw storageErr;
        }

        // 3. Update the media record with the real URL and mark as success
        await db.media.updateFields(mediaRecord.id, { url: publicUrl });
        await markMediaStatus(db, mediaRecord.id, "success");

        console.log(`✅ [AssetsRoute] Upload complete → media:${mediaRecord.id}`);

        return res.json({
            ok:          true,
            url:         publicUrl,
            media_id:    mediaRecord.id,
            workflow_id: wf.id,
            asset_id:    mediaRecord.id, // backward compat alias
            type:        isVideo ? "video" : "image",
            width:       width,
            height:      height,
            ratio:       ratio,
            resolution:  resolution,
            size:        size,
        });

    } catch (err) {
        console.error("❌ [AssetsRoute] Upload error:", err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

// ─── DELETE /api/assets/:id ────────────────────────────────────────────────
// :id = media.id
router.delete("/:id", async (req, res) => {
    try {
        const { id } = req.params;

        // Fetch the media to get url and workflow_id
        const { data: mediaRecord, error: fetchErr } = await supabase
            .from("media")
            .select("id, url, workflow_id")
            .eq("id", id)
            .single();

        if (fetchErr || !mediaRecord) {
            return res.status(404).json({ ok: false, error: "Media not found" });
        }

        // Try to delete file from storage
        if (mediaRecord.url) {
            try {
                // Extract path from public URL
                const urlParts = mediaRecord.url.split("/storage/v1/object/public/");
                if (urlParts.length > 1) {
                    const filePath = urlParts[1].split("/").slice(1).join("/");
                    await storageService.remove?.(filePath) || await storageService.delete?.(filePath);
                }
            } catch (storageErr) {
                console.warn(`[AssetsRoute] Storage delete failed: ${storageErr?.message}`);
            }
        }

        // Delete media (CASCADE removes generation_config_references pointing to this media)
        const { error: deleteErr } = await supabase
            .from("media")
            .delete()
            .eq("id", id);

        if (deleteErr) throw deleteErr;

        // Check if workflow has any remaining media; if not, delete it too
        const { count } = await supabase
            .from("media")
            .select("id", { count: "exact", head: true })
            .eq("workflow_id", mediaRecord.workflow_id);

        if (count === 0) {
            await supabase.from("workflow").delete().eq("id", mediaRecord.workflow_id);
            console.log(`🧹 [AssetsRoute] Empty workflow ${mediaRecord.workflow_id} removed`);
        }

        console.log(`✅ [AssetsRoute] Deleted media:${id}`);
        return res.json({ ok: true });

    } catch (err) {
        console.error("❌ [AssetsRoute] Delete error:", err.message);
        return res.status(500).json({ ok: false, error: err.message });
    }
});

export default router;
