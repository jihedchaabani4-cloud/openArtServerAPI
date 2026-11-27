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
            const isKnownClientErr =
                (typeof err.statusCode === "number" && err.statusCode >= 400 && err.statusCode < 500) ||
                err.errorCode === "NOT_FOUND" ||
                err.errorCode === "LIMIT_EXCEEDED" ||
                err.errorCode === "QUOTA_EXCEEDED" ||
                err.errorCode === "VALIDATION_ERROR";
            const statusCode = isKnownClientErr
                ? (err.statusCode || (err.errorCode === "NOT_FOUND" ? 404 : 400))
                : 500;
            return res.status(statusCode).json({
                error: true,
                code: statusCode >= 500 ? "INTERNAL_ERROR" : (err.errorCode || "LIMIT_EXCEEDED"),
                message: statusCode >= 500 ? "Internal server error" : err.message,
                details: statusCode >= 500 ? null : (err.details || null),
            });
        }
    };
}

export const preUploadElementCapacityGuard = createPreUploadElementCapacityGuard();
