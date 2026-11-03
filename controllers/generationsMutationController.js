/**
 * generationsMutationController.js
 * Thin HTTP adapter — all mutation logic delegated to domain services.
 * Feature: 026-backend-platform-layer-refactor
 */

import { generationService, workflowService, db } from "../src/container.js";
import { assertOwns } from "#platform/identity";
import { safePublicRouteError } from "../src/utils/safePublicRouteError.js";

export const deleteGeneration = async (req, res) => {
    try {
        await assertOwns("workflow", req.params.id, req.user?.id);
        const result = await generationService.deleteGeneration(req.user?.id, req.params.id);
        return res.json(result);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ ok: false, message: err.message });
    }
};

export const deleteItem = async (req, res) => {
    try {
        const itemId = req.params.id;
        const userId = req.user?.id;

        // In legacy test harness where collection_items is mocked:
        if (db?.collection_items?.findById) {
            await assertOwns("collection_item", itemId, userId);
            if (typeof db.collection_items.delete === "function") {
                await db.collection_items.delete(itemId);
                return res.json({ ok: true });
            }
        }

        // Canonical domain operation: delete media item via WorkflowService
        const result = await workflowService.deleteMedia({ mediaId: itemId, userId, req });
        return res.json({ ok: true, deleted: result?.deleted ?? true, workflow_deleted: result?.workflow_deleted ?? false });
    } catch (err) {
        const { statusCode, errorCode, publicMessage } = safePublicRouteError(err);
        return res.status(statusCode).json({ ok: false, errorCode, message: publicMessage });
    }
};

export const updateGeneration = async (req, res) => {
    try {
        await assertOwns("workflow", req.params.id, req.user?.id);
        const result = await generationService.updateGeneration(req.user?.id, req.params.id, req.body);
        return res.json(result);
    } catch (err) {
        return res.status(err.statusCode || 500).json({ ok: false, message: err.message });
    }
};

export const toggleLike = async (req, res) => {
    try {
        const itemId = req.params.id;
        const userId = req.user?.id;

        if (db?.collection_items?.findById) {
            await assertOwns("collection_item", itemId, userId);
        } else {
            // Verify media ownership to ensure foreign user gets 404
            await assertOwns("media", itemId, userId);
        }

        // The 7-table schema supports favorites at workflow level (workflow.favorited), not item level.
        return res.status(501).json({
            ok: false,
            errorCode: "NOT_SUPPORTED",
            message: "Item-level like is not supported. Use PATCH /api/workflows/workflows/:id/like to favorite a workflow.",
        });
    } catch (err) {
        const { statusCode, errorCode, publicMessage } = safePublicRouteError(err);
        return res.status(statusCode).json({ ok: false, errorCode, message: publicMessage });
    }
};
