/**
 * generationsQueryController.js — thin HTTP adapter.
 * All business logic delegated to GenerationService.
 * Feature: 026-backend-platform-layer-refactor
 */
import { getGenerationServices } from "../services/serviceAccessor.js";
import { safePublicRouteError } from "#shared";

export const getAssets = async (req, res) => {
    try {
        const { project_id } = req.params;
        if (!project_id || project_id === "null") return res.json({ ok: true, data: [] });
        const { limit, offset } = req.query;
        const { generationService } = getGenerationServices();
        const result = await generationService.getAssets(req.user.id, project_id, { limit, offset });
        res.json({ ok: true, ...result });
    } catch (err) {
        const { statusCode, publicMessage } = safePublicRouteError(err);
        res.status(statusCode).json({ ok: false, message: publicMessage });
    }
};

export const getUserLibrary = async (req, res) => {
    try {
        const { project_id, limit, offset } = req.query;
        const { generationService } = getGenerationServices();
        const result = await generationService.getUserLibrary(req.user.id, { projectId: project_id, limit, offset });
        res.json({ ok: true, ...result });
    } catch (err) {
        const { statusCode, publicMessage } = safePublicRouteError(err);
        res.status(statusCode).json({ ok: false, message: publicMessage });
    }
};

export const getLibraryWorkflowDetail = async (req, res) => {
    try {
        const { workflow_id } = req.params;
        if (!workflow_id) return res.status(400).json({ ok: false, message: "workflow_id is required" });
        const { generationService } = getGenerationServices();
        const data = await generationService.getWorkflowDetail(req.user.id, workflow_id);
        res.json({ ok: true, data });
    } catch (err) {
        const { statusCode, publicMessage } = safePublicRouteError(err);
        res.status(statusCode).json({ ok: false, message: publicMessage });
    }
};
