import { Router } from "express";
import { assetUploadService } from "../src/container.js";
import { requireAuth } from "../src/middleware/auth.js";
import { createUploadMiddleware } from "../src/middleware/uploadMiddleware.js";
import { DEFAULT_UPLOAD_POLICY } from "../src/platform/media-ingestion/UploadPolicy.js";
import { createLogger } from "../src/infrastructure/logging/index.js";
import { safePublicRouteError } from "../src/utils/safePublicRouteError.js";

const routeLogger = createLogger("route:mediaIngest");

const router = Router();
router.use(requireAuth);

const upload = createUploadMiddleware(DEFAULT_UPLOAD_POLICY);

/**
 * POST /api/media/ingest
 * Canonical ingestion endpoint: accepts multipart file, URL string, Base64 data URI, or media_id.
 */
router.post("/ingest", upload, async (req, res) => {
    try {
        const userId = req.user.id;
        const sourceInput = req.file || req.body?.source || req.body?.image_url || req.body?.media_id || req.body?.base64;

        if (!sourceInput) {
            return res.status(400).json({
                ok: false,
                error: "No source provided. Expected multipart file, URL, Base64, or media_id.",
            });
        }

        const {
            project_id,
            session_id,
            workflow_id,
            display_name,
        } = req.body || {};

        if (req.body?.purpose) {
            routeLogger.warn("Client supplied deprecated 'purpose' parameter; ignoring in favor of DEFAULT_UPLOAD_POLICY", {
                purpose: req.body.purpose,
                userId,
            });
        }

        const rawFolder = req.body?.folder_id ?? req.body?.folderId ?? req.body?.collection_id ?? req.body?.collectionId ?? req.query?.folder_id ?? req.query?.folderId ?? req.query?.collection_id ?? req.query?.collectionId ?? null;
        const normalizedFolder = (rawFolder && !["null", "undefined", "none", ""].includes(String(rawFolder).trim().toLowerCase()))
            ? String(rawFolder).trim()
            : null;

        const result = await assetUploadService.uploadAsset({
            source: sourceInput,
            userId,
            projectId: project_id,
            sessionId: session_id,
            workflowId: workflow_id,
            folderId: normalizedFolder,
            displayName: display_name,
            req,
        });

        return res.json({
            ok: true,
            media_id: result.mediaId,
            workflow_id: result.workflowId,
            folder_id: result.folder_id ?? null,
            folderId: result.folderId ?? null,
            collection_id: result.folder_id ?? null,
            collectionId: result.folderId ?? null,
            url: result.url,
            type: result.type,
            width: result.width,
            height: result.height,
            ratio: result.ratio,
            format: result.format,
            is_new: result.isNew,
            media: result.media,
        });
    } catch (err) {
        const { statusCode, errorCode, publicMessage } = safePublicRouteError(err);
        routeLogger.error("Failed to ingest media", {
            error: err.message,
            statusCode,
        });
        return res.status(statusCode).json({
            ok: false,
            errorCode,
            error: publicMessage,
        });
    }
});

export default router;
