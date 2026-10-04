/**
 * generationsMutationController.js
 * Thin HTTP adapter — all mutation logic delegated to GenerationService.
 * Feature: 026-backend-platform-layer-refactor
 */

import { generationService } from "../src/container.js";
import { assertOwns } from "../src/platform/security/ownership.js";

export const deleteGeneration = async (req, res) => {
    try {
        await assertOwns("workflow", req.params.id, req.user?.id);
        const result = await generationService.deleteGeneration(req.user?.id, req.params.id);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ ok: false, message: err.message });
    }
};

export const deleteItem = async (req, res) => {
    try {
        await assertOwns("collection_item", req.params.id, req.user?.id);
        const { deleteOne } = await import("../lib/supabaseCrud.js");
        await deleteOne("collection_items", req.params.id);
        res.json({ ok: true });
    } catch (err) {
        res.status(err.statusCode || 500).json({ ok: false, message: err.message });
    }
};

export const updateGeneration = async (req, res) => {
    try {
        await assertOwns("workflow", req.params.id, req.user?.id);
        const result = await generationService.updateGeneration(req.user?.id, req.params.id, req.body);
        res.json(result);
    } catch (err) {
        res.status(err.statusCode || 500).json({ ok: false, message: err.message });
    }
};

export const toggleLike = async (req, res) => {
    try {
        await assertOwns("collection_item", req.params.id, req.user?.id);
        // is_liked not natively supported in new schema yet — placeholder
        res.json({ ok: true, note: "is_liked not natively supported in new schema yet." });
    } catch (err) {
        res.status(err.statusCode || 500).json({ ok: false, message: err.message });
    }
};
