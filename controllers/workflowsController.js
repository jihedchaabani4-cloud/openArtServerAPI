import { supabase } from "../lib/supabase.js";
import { assertMediaUsable } from "../lib/mediaGuards.js";
import { storageService } from "../src/container.js";

function extractPath(url) {
    if (!url || typeof url !== "string") return null;
    // Extract the path after the bucket name (e.g., .../public/generations/path/to/file.png)
    // Most Supabase URLs look like: .../storage/v1/object/public/uploads/userId/filename.png
    const parts = url.split("/public/");
    if (parts.length > 1) {
        // parts[1] is "bucket/path/to/file"
        // We need "path/to/file"
        const subParts = parts[1].split("/");
        return subParts.slice(1).join("/");
    }
    return null;
}

// ── BACKEND UTILS (Not directly exposed as APIs) ────────────────────────────────

export const getWorkflows = async (filters = {}, options = {}) => {
    try {
        const { select = "*", order = { column: "create_time", ascending: false } } = options;
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
        if (!project_id) {
            throw new Error("project_id is required");
        }

        const newWorkflow = {
            project_id,
            session_id:       session_id       || null,  // null = project-level workflow
            display_name:     display_name     || "Untitled Workflow",
            variation_index:  variation_index  || 0,
            primary_media_id: primary_media_id || null,
        };

        if (workflow_type) {
            newWorkflow.workflow_type = workflow_type;
        }

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

// ── PATCH /api/workflows/:id ────────────────────────────────────────────────────
export const patchWorkflow = async (req, res) => {
    try {
        const { id } = req.params;
        const { display_name, primary_media_id, favorited } = req.body || {};

        const updates = {};

        if (display_name !== undefined) {
            const cleanedName = String(display_name || "").trim();
            updates.display_name = cleanedName || "Untitled Workflow";
        }

        if (primary_media_id !== undefined) {
            updates.primary_media_id = primary_media_id || null;
        }

        if (favorited !== undefined) {
            updates.favorited = !!favorited;
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ ok: false, message: "No supported workflow fields provided" });
        }

        const workflow = await updateWorkflow(id, updates);
        return res.json({ ok: true, workflow });
    } catch (err) {
        console.error(`❌ Error patching workflow ${req.params.id}:`, err);
        return res.status(500).json({ ok: false, message: err.message });
    }
};

// ── EXPRESS CONTROLLERS ─────────────────────────────────────────────────────────

export const deleteWorkflow = async (req, res) => {
    const { id } = req.params;

    res.json({ ok: true, message: "Deletion in progress" });

    (async () => {
        try {
            // 1. جيب media
            const { data: mediaItems } = await supabase
                .from("media")
                .select("id, url")
                .eq("workflow_id", id);

            if (mediaItems?.length) {
                const mediaIds = mediaItems.map(m => m.id);
                const filePaths = mediaItems
                    .map(m => extractPath(m.url))
                    .filter(Boolean);

                // 2. امسح references
                await supabase
                    .from("generation_config_reference")
                    .delete()
                    .in("ref_media_id", mediaIds);

                // 3. امسح media
                await supabase
                    .from("media")
                    .delete()
                    .eq("workflow_id", id);

                // 4. امسح storage
                if (filePaths.length) {
                    await storageService.deleteFiles(filePaths);
                }
            }

            // 5. امسح workflow
            await supabase
                .from("workflow")
                .delete()
                .eq("id", id);

        } catch (err) {
            console.error("Delete Error:", err);
        }
    })();
};
// ── PATCH /api/workflows/:id/like ───────────────────────────────────────────────
export const toggleLike = async (req, res) => {
    try {
        const { id } = req.params;

        // First, get the current state
        const { data: wf, error: getErr } = await supabase
            .from("workflow")
            .select("favorited")
            .eq("id", id)
            .single();
            
        if (getErr) throw getErr;

        // Toggle the state
        const newState = !wf.favorited;

        const { data, error } = await supabase
            .from("workflow")
            .update({ favorited: newState })
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

// ── PATCH /api/workflows/:id/move ─────────────────────────────────────────────
export const moveWorkflow = async (req, res) => {
    try {
        const { id } = req.params;
        const { session_id, project_id, newsession, session_name } = req.body;

        console.log(`\n📦 [moveWorkflow] Request received:`);
        console.log(`   workflow_id  : ${id}`);
        console.log(`   session_id   : ${session_id || "(not provided)"}`);
        console.log(`   project_id   : ${project_id || "(not provided)"}`);
        console.log(`   newsession   : ${newsession || false}`);
        console.log(`   session_name : ${session_name || "(not provided)"}`);

        if (!session_id && !newsession) {
            console.warn(`⚠️  [moveWorkflow] Missing session_id and newsession — rejecting`);
            return res.status(400).json({ ok: false, message: "session_id or newsession is required" });
        }

        let targetSessionId = session_id;
        let targetProjectId = project_id;
        let createdSession = null;

        // If creating a new session, we need the project ID (from body or DB)
        if (newsession) {
            if (!targetProjectId) {
                console.log(`   🔍 [moveWorkflow] newsession=true but no project_id — fetching from DB...`);
                const { data: wf } = await supabase.from("workflow").select("project_id").eq("id", id).single();
                if (wf) targetProjectId = wf.project_id;
                console.log(`   project_id from DB: ${targetProjectId || "(not found)"}`);
            }
            if (!targetProjectId) {
                return res.status(400).json({ ok: false, message: "Cannot determine project_id for new session" });
            }

            const { data: newSession, error: sessionError } = await supabase
                .from("session")
                .insert([{
                    name:       session_name || "New Session",
                    project_id: targetProjectId,
                    position:   0,
                }])
                .select()
                .single();
                
            if (sessionError) throw new Error(`Failed to create session: ${sessionError.message}`);
            targetSessionId = newSession.id;
            createdSession = newSession;
            console.log(`   ✅ [moveWorkflow] New session created: ${targetSessionId}`);
        }

        const updates = { session_id: targetSessionId };
        if (targetProjectId) {
            updates.project_id = targetProjectId;
        }

        console.log(`\n   📝 [moveWorkflow] Updating workflow in DB...`);
        console.log(`   updates: ${JSON.stringify(updates)}`);

        const { data: workflow, error } = await supabase
            .from("workflow")
            .update(updates)
            .eq("id", id)
            .select()
            .single();

        if (error) {
            console.error(`   ❌ [moveWorkflow] DB update error:`, error);
            throw error;
        }

        console.log(`   ✅ [moveWorkflow] Workflow updated: session_id=${workflow?.session_id}`);

        // If project_id changed, cascade to child media items
        if (targetProjectId) {
            const { error: mediaError } = await supabase
                .from("media")
                .update({ project_id: targetProjectId })
                .eq("workflow_id", id);
            if (mediaError) {
                console.warn(`   ⚠️  [moveWorkflow] Media cascade update failed:`, mediaError.message);
            } else {
                console.log(`   ✅ [moveWorkflow] Media items cascaded to project_id=${targetProjectId}`);
            }
        }

        console.log(`\n✅ [moveWorkflow] Done — workflow moved to session ${targetSessionId}\n`);
        return res.json({ ok: true, workflow, new_session: createdSession });
    } catch (err) {
        console.error(`❌ [moveWorkflow] Error moving workflow ${req.params.id}:`, err);
        return res.status(500).json({ ok: false, message: err.message });
    }
};

// ── PATCH /api/workflows/:id/primary-media ──────────────────────────────────────
export const setPrimaryMedia = async (req, res) => {
    try {
        const { id } = req.params;
        const { media_id } = req.body;

        if (!media_id) {
            return res.status(400).json({ ok: false, message: "media_id is required" });
        }

        // Security: only allow setting primary media to a completed or processing media belonging to this workflow.
        // We don't require project/session in the request here, but we at least enforce workflow match + completed/processing.
        await assertMediaUsable({ media_id, workflow_id: id }, { allowProcessing: true });

        const { data, error } = await supabase
            .from("workflow")
            .update({ primary_media_id: media_id })
            .eq("id", id)
            .select()
            .single();

        if (error) throw error;

        return res.json({ ok: true, primary_media_id: data.primary_media_id });
    } catch (err) {
        console.error(`❌ Error setting primary media for workflow ${req.params.id}:`, err);
        return res.status(err.statusCode || 500).json({ ok: false, message: err.message });
    }
};

// ── GET /api/workflows/workflow-by-media/:media_id ─────────────────────────────
// Returns the workflow that owns this media (and optionally its media list).
export const getWorkflowByMedia = async (req, res) => {
    try {
        const { media_id } = req.params;
        if (!media_id) return res.status(400).json({ ok: false, message: "media_id is required" });

        // Ensure media exists and load workflow context
        const media = await supabase
            .from("media")
            .select("id, workflow_id, project_id, status, url, create_time, error_message")
            .eq("id", media_id)
            .single();

        if (media.error) throw media.error;
        if (!media.data) return res.status(404).json({ ok: false, message: "Media not found" });

        const workflowId = media.data.workflow_id;
        const { data: workflow, error: wfErr } = await supabase
            .from("workflow")
            .select("*")
            .eq("id", workflowId)
            .single();
        if (wfErr) throw wfErr;

        const { data: items, error: itemsErr } = await supabase
            .from("media")
            .select("*")
            .eq("workflow_id", workflowId)
            .order("create_time", { ascending: true });
        if (itemsErr) throw itemsErr;

        return res.json({
            ok: true,
            workflow,
            items,
        });
    } catch (err) {
        console.error("❌ Error fetching workflow by media:", err);
        return res.status(500).json({ ok: false, message: err.message });
    }
};

// ── POST /api/workflows/detach-media ───────────────────────────────────────────
// Creates a new workflow and moves a media item into it (becomes primary).
export const detachMediaToNewWorkflow = async (req, res) => {
    try {
        const {
            media_id,
            project_id,   // optional (validated if provided)
            session_id,   // optional (validated if provided)
            display_name, // optional
        } = req.body || {};

        if (!media_id) return res.status(400).json({ ok: false, message: "media_id is required" });

        // Fetch media + its current workflow context
        const { data: media, error: mediaErr } = await supabase
            .from("media")
            .select("*, workflow:workflow!workflow_id(id, project_id, session_id, display_name)")
            .eq("id", media_id)
            .single();
        if (mediaErr) throw mediaErr;
        if (!media) return res.status(404).json({ ok: false, message: "Media not found" });

        const status = (media.status || "").toString().toLowerCase();
        if (["processing", "pending", "uploading"].includes(status)) {
            return res.status(403).json({ ok: false, message: "Cannot detach media while generation is in progress" });
        }

        const currentWorkflowId = media.workflow_id;
        const inferredProjectId = media.project_id || media.workflow?.project_id || null;
        const inferredSessionId = media.workflow?.session_id || null;

        // Optional strict checks if caller sends project/session
        if (project_id && inferredProjectId && project_id !== inferredProjectId) {
            return res.status(403).json({ ok: false, message: "media_id does not belong to this project" });
        }
        if (session_id && inferredSessionId && session_id !== inferredSessionId) {
            return res.status(403).json({ ok: false, message: "media_id does not belong to this session" });
        }

        if (!inferredProjectId || !inferredSessionId) {
            return res.status(400).json({ ok: false, message: "Unable to infer project_id/session_id for this media" });
        }

        // Create a new workflow
        const newName = display_name || media.workflow?.display_name || "Detached media";
        const { data: newWorkflow, error: wfErr } = await supabase
            .from("workflow")
            .insert({
                project_id: inferredProjectId,
                session_id: inferredSessionId,
                display_name: newName,
                variation_index: 0,
                primary_media_id: null,
            })
            .select("*")
            .single();
        if (wfErr) throw wfErr;

        // Move media to the new workflow
        const { data: movedMedia, error: moveErr } = await supabase
            .from("media")
            .update({ workflow_id: newWorkflow.id, project_id: inferredProjectId })
            .eq("id", media_id)
            .select("*")
            .single();
        if (moveErr) throw moveErr;

        // Set as primary
        const { data: updatedWorkflow, error: primErr } = await supabase
            .from("workflow")
            .update({ primary_media_id: media_id })
            .eq("id", newWorkflow.id)
            .select("*")
            .single();
        if (primErr) throw primErr;

        // If original workflow pointed to this media as primary, try to pick another one (or null)
        if (currentWorkflowId) {
            const { data: oldWf, error: oldWfErr } = await supabase
                .from("workflow")
                .select("id, primary_media_id")
                .eq("id", currentWorkflowId)
                .single();
            if (!oldWfErr && oldWf?.primary_media_id === media_id) {
                const { data: remaining } = await supabase
                    .from("media")
                    .select("id")
                    .eq("workflow_id", currentWorkflowId)
                    .order("create_time", { ascending: true })
                    .limit(1);
                const nextPrimary = remaining?.[0]?.id ?? null;
                await supabase
                    .from("workflow")
                    .update({ primary_media_id: nextPrimary })
                    .eq("id", currentWorkflowId);
            }
        }

        return res.json({
            ok: true,
            workflow: updatedWorkflow,
            media: movedMedia,
        });
    } catch (err) {
        console.error("❌ Error detaching media to new workflow:", err);
        return res.status(500).json({ ok: false, message: err.message });
    }
};

// ── DELETE /api/workflows/media/:media_id ───────────────────────────────────────
export const deleteMedia = async (req, res) => {
    try {
        const { media_id } = req.params;
        if (!media_id) {
            return res.status(400).json({ ok: false, message: "media_id is required" });
        }

        // Clean up any references pointing to this media item
        await supabase
            .from("generation_config_reference")
            .delete()
            .eq("ref_media_id", media_id);

        const { data, error } = await supabase
            .from("media")
            .delete()
            .eq("id", media_id)
            .select()
            .single();

        if (error) throw error;

        return res.json({ ok: true, deleted: data });
    } catch (err) {
        console.error(`❌ Error deleting media ${req.params.media_id}:`, err);
        return res.status(500).json({ ok: false, message: err.message });
    }
};
