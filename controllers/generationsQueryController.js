/**
 * generationsQueryController.js — thin HTTP adapter.
 * All business logic delegated to GenerationService.
 * Feature: 026-backend-platform-layer-refactor
 */
import { generationService } from "../src/container.js";

export const getAssets = async (req, res) => {
    try {
        const { project_id } = req.params;
        if (!project_id || project_id === "null") return res.json({ ok: true, data: [] });
        const { session_id, limit, offset } = req.query;
        const result = await generationService.getAssets(req.user.id, project_id, { sessionId: session_id, limit, offset });
        res.json({ ok: true, ...result });
    } catch (err) {
        res.status(err.statusCode || 500).json({ ok: false, message: err.message });
    }
};

export const getUserLibrary = async (req, res) => {
    try {
        const { project_id, session_id, limit, offset } = req.query;
        const result = await generationService.getUserLibrary(req.user.id, { projectId: project_id, sessionId: session_id, limit, offset });
        res.json({ ok: true, ...result });
    } catch (err) {
        res.status(err.statusCode || 500).json({ ok: false, message: err.message });
    }
};

export const getLibraryWorkflowDetail = async (req, res) => {
    try {
        const { workflow_id } = req.params;
        if (!workflow_id) return res.status(400).json({ ok: false, message: "workflow_id is required" });
        const data = await generationService.getWorkflowDetail(req.user.id, workflow_id);
        res.json({ ok: true, data });
    } catch (err) {
        res.status(err.statusCode || 500).json({ ok: false, message: err.message });
    }
};
