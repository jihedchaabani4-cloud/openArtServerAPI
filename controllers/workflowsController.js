import { supabase } from "../lib/supabase.js";
import { workflowService, projectReadService } from "../src/container.js";

// ── BACKEND UTILS (used by services and repositories — NOT direct HTTP handlers) ──
// These are kept here for backward compatibility with WorkflowCreationService
// and elementService which call them via WorkflowRepository.
// WorkflowRepository is now repository-pure and no longer calls these.
// These can be removed in a future cleanup once all callers migrate to repository methods.

export const getWorkflows = async (filters = {}, options = {}) => {
    try {
        const { select = "*", order = { column: "create_time", ascending: false } } = options;
        // TODO(027): migrate getWorkflows supabase.from("workflow") to WorkflowRepository.findByFilters()
        let query = supabase.from("workflow").select(select);

        if (order) query = query.order(order.column, { ascending: order.ascending });
        if (filters.project_id) query = query.eq("project_id", filters.project_id);
        if (filters.session_id) query = query.eq("session_id", filters.session_id);

        const { data, error } = await query;
        if (error) throw error;
        return data;
    } catch (err) {
        console.error("❌ Error fetching workflows:", err);
        throw err;
    }
};

export const getWorkflow = async (id) => {
    try {
        const { data, error } = await supabase
            .from("workflow")
            .select("*")
            .eq("id", id)
            .single();
        if (error) throw error;
        return data;
    } catch (err) {
        console.error(`❌ Error fetching workflow ${id}:`, err);
        throw err;
    }
};

export const createWorkflow = async ({ project_id, session_id, display_name, primary_media_id, variation_index, workflow_type }, options = {}) => {
    try {
        const newWorkflow = {
            project_id:       project_id       || null,
            session_id:       session_id       || null,
            display_name:     display_name     || "Untitled Workflow",
            variation_index:  variation_index  || 0,
            primary_media_id: primary_media_id || null,
        };
        if (workflow_type) newWorkflow.workflow_type = workflow_type;

        const { select = "*" } = options;
        const { data, error } = await supabase
            .from("workflow")
            .insert(newWorkflow)
            .select(select)
            .single();
        if (error) throw error;
        return data;
    } catch (err) {
        console.error("❌ Error creating workflow:", err);
        throw err;
    }
};

export const updateWorkflow = async (id, updates) => {
    try {
        const { data, error } = await supabase
            .from("workflow")
            .update(updates)
            .eq("id", id)
            .select()
            .single();
        if (error) throw error;
        return data;
    } catch (err) {
        console.error(`❌ Error updating workflow ${id}:`, err);
        throw err;
    }
};

// ── EXPRESS CONTROLLERS ───────────────────────────────────────────────────────
// All mutable CRUD actions delegate to WorkflowLifecycleService.
// Controllers handle only: auth, request validation, response shaping.

// ── PATCH /api/workflows/:id ──────────────────────────────────────────────────
export const patchWorkflow = async (req, res) => {
    const { id } = req.params;
    const userId = req.user?.id;
    console.log(`\n======================================================`);
    console.log(`📡 [workflowsController] PATCH /api/workflows/${id}`);
    console.log(`👤 User ID: ${userId || "Unauthenticated"}`);

    try {
        const { display_name, name, primary_media_id, favorited } = req.body || {};

        const updates = {};
        const targetName = display_name !== undefined ? display_name : name;
        if (targetName !== undefined) updates.display_name = targetName;
        if (primary_media_id !== undefined) updates.primary_media_id = primary_media_id;
        if (favorited !== undefined) updates.favorited = favorited;

        // Delegate to WorkflowLifecycleService
        const result = await workflowService.updateWorkflowMetadata({
            workflowId: id,
            updates,
            userId,
            req,
        });

        console.log(`✅ [workflowsController] patchWorkflow ${id} success`);
        console.log(`======================================================\n`);

        return res.json({ ok: true, workflow: result.workflow });
    } catch (err) {
        console.error(`❌ [workflowsController] patchWorkflow ${id}:`, err.message);
        console.log(`======================================================\n`);
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

        // Ownership check
        const isAuthorized = await workflowService._verifyWorkflowOwnership(id, userId, req);
        if (!isAuthorized) {
            return res.status(403).json({ ok: false, message: "Unauthorized access to this workflow" });
        }

        const { data: wf, error: getErr } = await supabase
            .from("workflow")
            .select("favorited")
            .eq("id", id)
            .single();
        if (getErr) throw getErr;

        const { data, error } = await supabase
            .from("workflow")
            .update({ favorited: !wf.favorited })
            .eq("id", id)
            .select()
            .single();
        if (error) throw error;

        return res.json({ ok: true, favorited: data.favorited });
    } catch (err) {
        console.error(`❌ Error toggling like for workflow ${req.params.id}:`, err);
        return res.status(500).json({ ok: false, message: err.message });
    }
};

// ── PATCH /api/workflows/like (bulk) ─────────────────────────────────────────
export const bulkToggleLike = async (req, res) => {
    try {
        const userId = req.user.id;
        const rawIds = req.body?.workflow_ids;
        const values = Array.isArray(rawIds) ? rawIds : [rawIds];
        const workflowIds = [...new Set(values.map((v) => String(v || "").trim()).filter(Boolean))];

        if (!workflowIds.length) {
            return res.status(400).json({ ok: false, message: "workflow_ids is required" });
        }

        const ownedIds = await workflowService._verifyWorkflowOwnershipBulk(workflowIds, userId, req);
        if (!ownedIds) {
            return res.status(403).json({ ok: false, message: "Unauthorized access to one or more workflows" });
        }

        const { data: currentRows, error: getErr } = await supabase
            .from("workflow")
            .select("id, favorited")
            .in("id", ownedIds);
        if (getErr) throw getErr;

        const explicitFavorited    = req.body?.favorited;
        const allCurrentlyFavorited = (currentRows || []).every((row) => !!row.favorited);
        const nextFavorited         = explicitFavorited === undefined ? !allCurrentlyFavorited : !!explicitFavorited;

        const { data, error } = await supabase
            .from("workflow")
            .update({ favorited: nextFavorited })
            .in("id", ownedIds)
            .select("id, favorited");
        if (error) throw error;

        return res.json({
            ok: true,
            workflow_ids: ownedIds,
            count:        ownedIds.length,
            favorited:    nextFavorited,
            workflows:    data || [],
        });
    } catch (err) {
        console.error("Bulk like error:", err);
        return res.status(500).json({ ok: false, message: err.message });
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
        console.error(`❌ [moveWorkflow] Error moving workflow ${req.params.id}:`, err);
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
        console.error(`❌ Error setting primary media for workflow ${req.params.id}:`, err);
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
        console.error("❌ Error fetching workflow by media:", err);
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
        console.error("❌ Error detaching media to new workflow:", err);
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
        console.error(`❌ Error deleting media ${req.params.media_id}:`, err);
        return res.status(err.statusCode || 500).json({ ok: false, message: err.message });
    }
};
