import { workflowService, projectReadService, characterService, elementService } from "../src/container.js";
import { createLogger } from "../src/infrastructure/logging/index.js";

const controllerLogger = createLogger("controller");

// ── EXPRESS CONTROLLERS ───────────────────────────────────────────────────────
// All mutable CRUD actions delegate to WorkflowLifecycleService.
// Controllers handle only: auth, request validation, response shaping.

// ── PATCH /api/workflows/:id ──────────────────────────────────────────────────
export const patchWorkflow = async (req, res) => {
    const { id } = req.params;
    const cleanId = String(id || '').replace(/^workflows\//, '').trim();
    const userId = req.user?.id;
    controllerLogger.debug({ workflowId: cleanId, userId }, `PATCH /api/workflows/${cleanId}`);

    try {
        const body = req.body || {};

        // Mass-assignment defense (F-T6 / D-16): reject attempts to modify folderId, projectId, or userId via generic workflow update
        const forbiddenKeys = ["folderId", "folder_id", "projectId", "project_id", "userId", "user_id"];
        for (const key of forbiddenKeys) {
            if (body[key] !== undefined) {
                return res.status(400).json({
                    ok: false,
                    code: "MASS_ASSIGNMENT_FORBIDDEN",
                    message: `Updating '${key}' via generic workflow update is forbidden`,
                });
            }
        }

        const { display_name, name, primary_media_id, favorited, description, character_info } = body;

        let targetWorkflowId = cleanId;
        // Resolve media_id to its parent workflow_id if cleanId is not directly a workflow
        const wfExists = await workflowService.db.workflows.findById(cleanId).catch(() => null);
        if (!wfExists) {
            const mediaRecord = await workflowService.db.media.findById(cleanId).catch(() => null);
            if (mediaRecord?.workflow_id) {
                targetWorkflowId = mediaRecord.workflow_id;
            }
        }

        const updates = {};
        const targetName = display_name !== undefined ? display_name : name;
        if (targetName !== undefined) updates.display_name = targetName;
        if (primary_media_id !== undefined) updates.primary_media_id = primary_media_id;
        if (favorited !== undefined) updates.favorited = favorited;

        // Delegate to WorkflowLifecycleService
        const result = await workflowService.updateWorkflowMetadata({
            workflowId: targetWorkflowId,
            updates,
            userId,
            req,
        });

        // If character description or info or name is passed, sync with character table
        const descVal = description !== undefined ? description : character_info;
        if (descVal !== undefined || targetName !== undefined) {
            await characterService.updateCharacter({
                characterId: targetWorkflowId,
                updates: {
                    ...(descVal !== undefined ? { description: descVal, character_info: descVal } : {}),
                    ...(targetName !== undefined ? { name: targetName } : {}),
                },
                userId,
            }).catch((charErr) => {
                controllerLogger.warn({ workflowId: targetWorkflowId, err: charErr }, `patchWorkflow character sync notice: ${charErr.message}`);
            });
        }

        // If this workflow is associated with an element, sync element name as well
        if (targetName !== undefined) {
            await elementService.updateElement(targetWorkflowId, { name: targetName }).catch(() => {});
        }

        controllerLogger.info({ workflowId: targetWorkflowId }, `patchWorkflow ${targetWorkflowId} success`);

        return res.json({ ok: true, workflow: result.workflow, display_name: targetName });
    } catch (err) {
        controllerLogger.error({ workflowId: cleanId, err }, `patchWorkflow ${cleanId} failed: ${err.message}`);
        return res.status(err.statusCode || 500).json({ ok: false, message: err.message });
    }
};

// ── DELETE /api/workflows/:id ─────────────────────────────────────────────────
export const deleteWorkflow = async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;

    try {
        const result = await workflowService.deleteWorkflow({ workflowId: id, userId, req });

        return res.json({
            ok: true,
            deleted_workflow_id: result.workflowId,
            deleted_media_count: result.deletedMediaCount,
            storage_failures:    result.storageFailures.length,
        });
    } catch (err) {
        return res.status(err.statusCode || 500).json({ ok: false, message: err.message });
    }
};

// ── DELETE /api/workflows (bulk) ──────────────────────────────────────────────
export const bulkDeleteWorkflows = async (req, res) => {
    const userId = req.user.id;
    const workflow_ids = req.body?.workflow_ids;

    try {
        const result = await workflowService.bulkDeleteWorkflows({
            workflowIds: workflow_ids,
            userId,
            req,
        });

        return res.json({
            ok: true,
            workflow_ids: result.workflow_ids,
            count:        result.count,
            results:      result.results,
        });
    } catch (err) {
        return res.status(err.statusCode || 500).json({ ok: false, message: err.message });
    }
};

// ── PATCH /api/workflows/:id/like ─────────────────────────────────────────────
export const toggleLike = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

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

// ── PATCH /api/workflows/:id/move ─────────────────────────────────────────────
export const moveWorkflow = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;
        const { session_id, project_id, newsession, session_name } = req.body;

        const result = await workflowService.moveWorkflow({
            workflowId:  id,
            sessionId:   session_id,
            projectId:   project_id,
            newsession,
            sessionName: session_name,
            userId,
            req,
        });

        return res.json({ ok: true, workflow: result.workflow, new_session: result.new_session });
    } catch (err) {
        controllerLogger.error({ workflowId: req.params.id, err }, `[moveWorkflow] Error moving workflow ${req.params.id}: ${err.message}`);
        return res.status(err.statusCode || 500).json({ ok: false, message: err.message });
    }
};

// ── PATCH /api/workflows/:id/primary-media ────────────────────────────────────
export const setPrimaryMedia = async (req, res) => {
    try {
        const { id } = req.params;
        const { media_id } = req.body;
        const userId = req.user.id;

        const result = await workflowService.setPrimaryMedia({
            workflowId: id,
            mediaId:    media_id,
            userId,
            req,
        });

        return res.json({ ok: true, primary_media_id: result.primary_media_id });
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
        const { media_id, project_id, session_id, display_name } = req.body || {};
        const userId = req.user.id;

        const result = await workflowService.detachMedia({
            mediaId:     media_id,
            projectId:   project_id,
            sessionId:   session_id,
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
        const userId = req.user.id;

        const result = await workflowService.deleteMedia({ mediaId: media_id, userId, req });

        return res.json({
            ok:                    true,
            deleted:               result.deleted,
            workflow_deleted:      result.workflow_deleted,
            next_primary_media_id: result.next_primary_media_id,
        });
    } catch (err) {
        controllerLogger.error({ mediaId: req.params.media_id, err }, `Error deleting media ${req.params.media_id}: ${err.message}`);
        return res.status(err.statusCode || 500).json({ ok: false, message: err.message });
    }
};
