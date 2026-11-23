import { getGenerationServices } from "../services/serviceAccessor.js";
import { WorkflowService } from "../services/WorkflowService.js";
import { db } from "../db/dbMap.js";
import { promptService } from "#models/tools";
import { createLogger } from "#shared";

const controllerLogger = createLogger("controller");

// ── EXPRESS CONTROLLERS ───────────────────────────────────────────────────────
// All mutable CRUD actions delegate to WorkflowLifecycleService.
// Controllers handle only: auth, request validation, response shaping.

// ── PATCH /api/workflows/:id ──────────────────────────────────────────────────
export const patchWorkflow = async (req, res) => {
    const { id } = req.params;
    const cleanId = String(id || "").replace(/^workflows\//, "").trim();
    const userId = req.user?.id;
    controllerLogger.debug({ workflowId: cleanId, userId }, `PATCH /api/workflows/${cleanId}`);

    try {
        const { workflowService } = getGenerationServices();
        const result = await workflowService.patchWorkflow({
            id: cleanId,
            userId,
            body: req.body || {},
            req,
        });

        controllerLogger.info({ workflowId: cleanId }, `patchWorkflow ${cleanId} success`);
        return res.json({ ok: true, workflow: result.workflow, display_name: result.displayName });
    } catch (err) {
        controllerLogger.error({ workflowId: cleanId, err }, `patchWorkflow ${cleanId} failed: ${err.message}`);
        return res.status(err.statusCode || 500).json({
            ok: false,
            code: err.code || err.errorCode,
            message: err.message,
        });
    }
};

// ── DELETE /api/workflows/:id ─────────────────────────────────────────────────
export const deleteWorkflow = async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;
    const trash = req.query?.trash ?? req.body?.trash;

    try {
        const { trashService } = getGenerationServices();
        const result = await trashService.requestDelete({ kind: "workflow", id, userId, trash, req });

        return res.json({
            ok: true,
            deleted_workflow_id: result.workflowId,
            deleted_media_count: result.deletedMediaCount || 0,
            storage_failures:    result.storageFailures?.length || 0,
            ...(result.trashed ? { trashed: true } : {}),
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        const errorCode = err.errorCode || err.code;
        return res.status(statusCode).json({
            ok: false,
            ...(errorCode ? { errorCode } : {}),
            message: err.message,
        });
    }
};

// ── DELETE /api/workflows (bulk) ──────────────────────────────────────────────
export const bulkDeleteWorkflows = async (req, res) => {
    const userId = req.user.id;
    const workflow_ids = req.body?.workflow_ids;
    const trash = req.query?.trash ?? req.body?.trash;

    try {
        const { trashService } = getGenerationServices();
        const result = await trashService.requestDeleteMany({
            ids: workflow_ids,
            userId,
            trash,
            req,
        });

        return res.json({
            ok: true,
            workflow_ids: result.workflow_ids,
            count:        result.count,
            results:      result.results,
            ...(result.trashed ? { trashed: true } : {}),
        });
    } catch (err) {
        const statusCode = err.statusCode || 500;
        const errorCode = err.errorCode || err.code;
        return res.status(statusCode).json({
            ok: false,
            ...(errorCode ? { errorCode } : {}),
            message: err.message,
        });
    }
};

// ── PATCH /api/workflows/:id/like ─────────────────────────────────────────────
export const toggleLike = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const { workflowService } = getGenerationServices();
        const result = await workflowService.toggleLike({ workflowId: id, userId, req });
        return res.json({ ok: true, favorited: result.favorited });
    } catch (err) {
        controllerLogger.error({ workflowId: req.params.id, err }, `Error toggling like for workflow ${req.params.id}: ${err.message}`);
        return res.status(err.statusCode || 500).json({ ok: false, message: err.message });
    }
};

// ── PATCH /api/workflows/like (bulk) ─────────────────────────────────────────
export const bulkToggleLike = async (req, res) => {
    try {
        const userId = req.user.id;
        const rawIds = req.body?.workflow_ids;

        const { workflowService } = getGenerationServices();
        const result = await workflowService.bulkToggleLike({
            workflowIds: rawIds,
            favorited:   req.body?.favorited,
            userId,
            req,
        });

        return res.json({
            ok:           true,
            workflow_ids: result.workflow_ids,
            count:        result.count,
            favorited:    result.favorited,
            workflows:    result.workflows,
        });
    } catch (err) {
        controllerLogger.error({ err }, `Bulk like error: ${err.message}`);
        return res.status(err.statusCode || 500).json({ ok: false, message: err.message });
    }
};


// ── PATCH /api/workflows/:id/primary-media ────────────────────────────────────
export const setPrimaryMedia = async (req, res) => {
    try {
        const { id } = req.params;
        const targetMediaId = req.body?.primaryMediaId !== undefined
            ? req.body.primaryMediaId
            : (req.body?.media_id ?? req.body?.mediaId);
        const userId = req.user.id;

        const { workflowService } = getGenerationServices();
        const result = await workflowService.setPrimaryMedia({
            workflowId: id,
            mediaId:    targetMediaId,
            userId,
            req,
        });

        const resolvedId = result?.primaryMediaId ?? result?.primary_media_id ?? targetMediaId;
        return res.json({
            ok: true,
            primaryMediaId: resolvedId,
            primary_media_id: resolvedId,
        });
    } catch (err) {
        controllerLogger.error({ workflowId: req.params.id, err }, `Error setting primary media for workflow ${req.params.id}: ${err.message}`);
        return res.status(err.statusCode || 500).json({ ok: false, message: err.message });
    }
};

// ── GET /api/workflows/workflow-by-media/:media_id ───────────────────────────
export const getWorkflowByMedia = async (req, res) => {
    try {
        const { media_id } = req.params;
        const userId = req.user.id;

        const { projectReadService } = getGenerationServices();
        const result = await projectReadService.getWorkflowByMedia({ mediaId: media_id, userId, req });
        return res.json({ ok: true, workflow: result.workflow, items: result.items });
    } catch (err) {
        controllerLogger.error({ mediaId: req.params.media_id, err }, `Error fetching workflow by media: ${err.message}`);
        return res.status(err.statusCode || 500).json({ ok: false, message: err.message });
    }
};

// ── POST /api/workflows/detach-media ─────────────────────────────────────────
export const detachMediaToNewWorkflow = async (req, res) => {
    try {
        const { media_id, project_id, display_name } = req.body || {};
        const userId = req.user.id;

        const { workflowService } = getGenerationServices();
        const result = await workflowService.detachMedia({
            mediaId:     media_id,
            projectId:   project_id,
            displayName: display_name,
            userId,
            req,
        });

        return res.json({ ok: true, workflow: result.workflow });
    } catch (err) {
        controllerLogger.error({ mediaId: req.body?.media_id, err }, `Error detaching media to new workflow: ${err.message}`);
        return res.status(err.statusCode || 500).json({ ok: false, message: err.message });
    }
};

// ── DELETE /api/workflows/media/:media_id ─────────────────────────────────────
export const deleteMedia = async (req, res) => {
    try {
        const { media_id } = req.params;
        const workflowId = req.params?.workflow_id || req.query?.workflow_id || req.query?.workflowId || req.body?.workflow_id || req.body?.workflowId || null;
        const userId = req.user.id;

        const { workflowService } = getGenerationServices();
        const result = await workflowService.deleteMedia({ mediaId: media_id, workflowId, userId, req });

        return res.json({
            ok:                    true,
            deleted:               result.deleted,
            workflow_deleted:      result.workflow_deleted,
            next_primary_media_id: result.next_primary_media_id,
        });
    } catch (err) {
        controllerLogger.error({ mediaId: req.params.media_id, err }, `Error deleting media ${req.params.media_id}: ${err.message}`);
        const statusCode = err.statusCode || 500;
        const errorCode = err.errorCode || err.code;
        return res.status(statusCode).json({
            ok: false,
            ...(errorCode ? { errorCode } : {}),
            message: err.message,
        });
    }
};

// ── POST /api/prompt/optimize ─────────────────────────────────────────────────
export const optimizePrompt = async (req, res) => {
    const { prompt, mode = "image" } = req.body || {};
    if (!prompt?.trim()) {
        return res.status(400).json({ ok: false, message: "prompt is required" });
    }
    try {
        const result = await promptService.optimizePrompt(prompt.trim(), {
            mode,
            userId: req.user?.id,
        });
        return res.json({ ok: true, ...result });
    } catch (err) {
        controllerLogger.error({ err }, `optimizePrompt failed: ${err.message}`);
        return res.status(500).json({ ok: false, message: "Failed to optimize prompt" });
    }
};

// ── GET /api/v2/workflows/health ──────────────────────────────────────────────
export const getWorkflowHealth = (req, res) => {
    return res.json({ engine: "v3", status: "ok" });
};

// ── POST /api/v2/workflows/run ────────────────────────────────────────────────
export const runWorkflowDisabled = (req, res) => {
    return res.status(404).json({
        code: "ENDPOINT_DISABLED",
        message: "POST /api/v2/workflows/run is disabled. Use /api/images/generated or /api/video/generated.",
    });
};

// ── GET /api/v2/workflows/runs/:run_id ────────────────────────────────────────
export const getWorkflowRunById = async (req, res) => {
    try {
        const runId = req.params.run_id;
        const { run } = await WorkflowService.getWorkflowRun({ runId, userId: req.user?.id });
        return res.json({ run });
    } catch (err) {
        if (err.statusCode === 404) {
            return res.status(404).json({ code: "RUN_NOT_FOUND", message: "Run not found" });
        }
        return res.status(err.statusCode || 500).json({
            ok: false,
            code: err.code || "INTERNAL_ERROR",
            message: err.message,
        });
    }
};

