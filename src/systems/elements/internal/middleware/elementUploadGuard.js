/**
 * Express middleware that validates Element ownership and current workflow_media quota
 * BEFORE any file upload stream is consumed or buffered by multipart middleware.
 */

import { getElementMediaService } from "../services/serviceAccessor.js";

export function createPreUploadElementCapacityGuard(serviceGetter = getElementMediaService) {
    return async function preUploadElementCapacityGuard(req, res, next) {
        try {
            const elementId = req.params.id;
            const userId = req.user?.id;
            const service = typeof serviceGetter === "function" ? serviceGetter() : serviceGetter;
            await service.assertUploadAllowed({ elementId, userId, incomingCount: 1 });
            return next();
        } catch (err) {
            const statusCode = err.statusCode || (err.errorCode === "NOT_FOUND" ? 404 : 400);
            return res.status(statusCode).json({
                error: true,
                code: err.errorCode || "LIMIT_EXCEEDED",
                message: err.message,
                details: err.details || null,
            });
        }
    };
}

export const preUploadElementCapacityGuard = createPreUploadElementCapacityGuard();
