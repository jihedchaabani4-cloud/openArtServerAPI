import { supabase, supabaseAdmin } from "../lib/supabase.js";
import { assertMediaUsable } from "../lib/mediaGuards.js";
import { storageService } from "../src/container.js";
import elementRepository from "../src/db/ElementRepository.js";

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
        const newWorkflow = {
            project_id:       project_id       || null,
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

// ── HELPERS ───────────────────────────────────────────────────────────────────

const verifyMediaOwnership = async (mediaId, userId, req = null) => {
    const secret = req?.headers?.["x-internal-secret"];
    const isInternal = secret && secret === (process.env.INTERNAL_SECRET || "openart_internal_s2s_secret_2026");
    const isDev = process.env.DEV_AUTH_BYPASS === "true" || process.env.DEV_AUTH_BYPASS === true;

    if (isInternal || isDev) return true;

    const { data: media, error } = await supabase
        .from("media")
        .select("id, project:project!project_id(user_id)")
        .eq("id", mediaId)
        .single();
    if (error || !media || (media.project?.user_id && media.project?.user_id !== userId)) return false;
    return true;
};

const normalizeWorkflowIds = (input) => {
    const values = Array.isArray(input) ? input : [input];
    return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))];
};

const verifyWorkflowOwnershipBulk = async (workflowIds, userId, req = null) => {
    if (!workflowIds.length) return [];

    const secret = req?.headers?.["x-internal-secret"];
    const isInternal = secret && secret === (process.env.INTERNAL_SECRET || "openart_internal_s2s_secret_2026");
    const isDev = process.env.DEV_AUTH_BYPASS === "true" || process.env.DEV_AUTH_BYPASS === true;

    if (isInternal || isDev) {
        return workflowIds;
    }

    const { data, error } = await supabase
        .from("workflow")
        .select("id, project:project!project_id(user_id)")
        .in("id", workflowIds);

    if (error) throw error;

    const ownedIds = (data || [])
        .filter((workflow) => !workflow.project?.user_id || workflow.project?.user_id === userId)
        .map((workflow) => workflow.id);

    if (ownedIds.length !== workflowIds.length) return null;
    return ownedIds;
};

const verifyWorkflowOwnership = async (workflowId, userId, req = null) => {
    const result = await verifyWorkflowOwnershipBulk([workflowId], userId, req);
    return Boolean(result && result.length === 1);
};

// ── PATCH /api/workflows/:id ────────────────────────────────────────────────────
export const patchWorkflow = async (req, res) => {
    const { id } = req.params;
    const userId = req.user?.id;
    console.log(`\n======================================================`);
    console.log(`📡 [SERVER BACKEND] PATCH /api/workflows/${id} received`);
    console.log(`👤 User ID: ${userId || "Unauthenticated"}`);
    console.log(`📦 Request Body:`, JSON.stringify(req.body, null, 2));

    try {
        const isAuthorized = await verifyWorkflowOwnership(id, userId, req);
        console.log(`🔐 Ownership Verification Result: ${isAuthorized ? "AUTHORIZED ✅" : "DENIED ❌"}`);

        if (!isAuthorized) {
            console.warn(`⛔ [SERVER BACKEND] 403 Forbidden: User ${userId} does not own workflow ${id}`);
            return res.status(403).json({ ok: false, message: "Unauthorized access to this workflow" });
        }

        const { display_name, name, primary_media_id, favorited, description, keywords, guidelines, metadata } = req.body || {};
        const updates = {};
        const elementUpdates = {};

        const targetName = display_name !== undefined ? display_name : name;
        if (targetName !== undefined) {
            const cleanedName = String(targetName || "").replace(/^@+/, "").trim();
            if (cleanedName.length > 0) {
                updates.display_name = cleanedName;
                console.log(`✏️ [SERVER BACKEND] Setting display_name to: "${updates.display_name}"`);
            } else {
                console.warn(`⚠️ [SERVER BACKEND] Empty character name received. Keeping existing display_name in DB.`);
            }
        }

        if (primary_media_id !== undefined) {
            updates.primary_media_id = primary_media_id || null;
        }

        if (favorited !== undefined) {
            updates.favorited = !!favorited;
        }

        let hasDescriptionUpdate = false;
        const descVal = description !== undefined ? description : character_info;
        if (descVal !== undefined) {
            hasDescriptionUpdate = true;
            console.log(`✏️ [SERVER BACKEND] Received description update for character...`);
        }

        if (Object.keys(updates).length === 0 && Object.keys(elementUpdates).length === 0 && !hasDescriptionUpdate) {
            console.warn(`⚠️ [SERVER BACKEND] 400 Bad Request: No supported workflow fields provided in body`);
            return res.status(400).json({ ok: false, message: "No supported workflow fields provided" });
        }

        console.log(`🔄 [SERVER BACKEND] Executing database update for workflow ${id}:`, updates);
        const workflow = Object.keys(updates).length > 0
            ? await updateWorkflow(id, updates)
            : await getWorkflow(id);

        // Synchronize dedicated 'public.characters' table if name or description is updated
        if (targetName !== undefined || descVal !== undefined) {
            try {
                const charPayload = { updated_at: new Date().toISOString() };
                if (targetName !== undefined) {
                    const cleanedName = String(targetName || "").replace(/^@+/, "").trim();
                    if (cleanedName.length > 0) {
                        charPayload.name = cleanedName;
                        charPayload.title = cleanedName;
                    }
                }
                if (descVal !== undefined) {
                    const cleanedDesc = String(descVal || "").trim();
                    charPayload.description = cleanedDesc;
                    charPayload.character_info = cleanedDesc;
                }

                console.log(`🎭 [SERVER BACKEND] Syncing payload to public.characters table for workflow_id ${id}:`, charPayload);
                let { data: charData, error: charErr } = await supabaseAdmin
                    .from("characters")
                    .update(charPayload)
                    .or(`workflow_id.eq.${id},id.eq.${id}`)
                    .select()
                    .maybeSingle();

                if (charErr) {
                    console.warn(`⚠️ [SERVER BACKEND] 'characters' table update notice:`, charErr.message);
                }

                if (!charData) {
                    console.log(`ℹ️ [SERVER BACKEND] No existing row in 'public.characters' table, upserting for workflow ${id}...`);
                    const { data: wfRow } = await supabaseAdmin
                        .from("workflow")
                        .select("id, project_id, user_id, display_name")
                        .eq("id", id)
                        .maybeSingle();

                    const upsertPayload = {
                        id,
                        workflow_id: id,
                        project_id: wfRow?.project_id || null,
                        user_id: user_id || wfRow?.user_id || "64950918-266f-42c7-a6d3-c13f87bbbcb8",
                        name: charPayload.name || wfRow?.display_name || "Untitled Character",
                        title: charPayload.title || wfRow?.display_name || "Untitled Character",
                        description: charPayload.description || "",
                        character_info: charPayload.character_info || "",
                        ...charPayload,
                    };

                    const { data: upsertedChar, error: upErr } = await supabaseAdmin
                        .from("characters")
                        .upsert(upsertPayload, { onConflict: "id" })
                        .select()
                        .maybeSingle();

                    if (upErr) {
                        console.warn(`⚠️ [SERVER BACKEND] 'characters' upsert error:`, upErr.message);
                    } else {
                        console.log(`✅ [SERVER BACKEND] Successfully upserted 'public.characters' row:`, upsertedChar);
                    }
                } else {
                    console.log(`✅ [SERVER BACKEND] 'characters' table updated successfully:`, charData);
                }
            } catch (cErr) {
                console.warn(`⚠️ [SERVER BACKEND] 'characters' table sync error:`, cErr.message);
            }
        }

        let element = null;
        if (Object.keys(elementUpdates).length > 0) {
            console.log(`🔄 [SERVER BACKEND] Updating element details for workflow ${id}:`, elementUpdates);
            element = await elementRepository.updateByWorkflowId(id, elementUpdates);
        }

        console.log(`✅ [SERVER BACKEND] Successfully updated workflow ${id}:`, {
            id: workflow?.id || id,
            display_name: workflow?.display_name,
            name: workflow?.name,
        });
        console.log(`======================================================\n`);

        return res.json({ ok: true, workflow, element });
    } catch (err) {
        console.error(`❌ [SERVER BACKEND] Error patching workflow ${req.params.id}:`, err);
        console.log(`======================================================\n`);
        return res.status(500).json({ ok: false, message: err.message });
    }
};

// ── EXPRESS CONTROLLERS ─────────────────────────────────────────────────────────

export const deleteWorkflow = async (req, res) => {
    const { id } = req.params;
    const userId = req.user.id;

    try {
        if (!(await verifyWorkflowOwnership(id, userId))) {
            return res.status(403).json({ ok: false, message: "Unauthorized access to this workflow" });
        }

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
    } catch (err) {
        return res.status(500).json({ ok: false, message: err.message });
    }
};

export const bulkDeleteWorkflows = async (req, res) => {
    const userId = req.user.id;
    const workflowIds = normalizeWorkflowIds(req.body?.workflow_ids);

    if (!workflowIds.length) {
        return res.status(400).json({ ok: false, message: "workflow_ids is required" });
    }

    try {
        const ownedIds = await verifyWorkflowOwnershipBulk(workflowIds, userId);
        if (!ownedIds) {
            return res.status(403).json({ ok: false, message: "Unauthorized access to one or more workflows" });
        }

        res.json({
            ok: true,
            message: "Bulk deletion in progress",
            workflow_ids: ownedIds,
            count: ownedIds.length,
        });

        (async () => {
            for (const workflowId of ownedIds) {
                try {
                    const { data: mediaItems } = await supabase
                        .from("media")
                        .select("id, url")
                        .eq("workflow_id", workflowId);

                    if (mediaItems?.length) {
                        const mediaIds = mediaItems.map((m) => m.id);
                        const filePaths = mediaItems
                            .map((m) => extractPath(m.url))
                            .filter(Boolean);

                        await supabase
                            .from("generation_config_reference")
                            .delete()
                            .in("ref_media_id", mediaIds);

                        await supabase
                            .from("media")
                            .delete()
                            .eq("workflow_id", workflowId);

                        if (filePaths.length) {
                            await storageService.deleteFiles(filePaths);
                        }
                    }

                    await supabase
                        .from("workflow")
                        .delete()
                        .eq("id", workflowId);
                } catch (err) {
                    console.error(`Bulk delete error for workflow ${workflowId}:`, err);
                }
            }
        })();
    } catch (err) {
        return res.status(500).json({ ok: false, message: err.message });
    }
};

// ── PATCH /api/workflows/:id/like ───────────────────────────────────────────────
export const toggleLike = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        if (!(await verifyWorkflowOwnership(id, userId))) {
            return res.status(403).json({ ok: false, message: "Unauthorized access to this workflow" });
        }

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

export const bulkToggleLike = async (req, res) => {
    try {
        const userId = req.user.id;
        const workflowIds = normalizeWorkflowIds(req.body?.workflow_ids);

        if (!workflowIds.length) {
            return res.status(400).json({ ok: false, message: "workflow_ids is required" });
        }

        const ownedIds = await verifyWorkflowOwnershipBulk(workflowIds, userId);
        if (!ownedIds) {
            return res.status(403).json({ ok: false, message: "Unauthorized access to one or more workflows" });
        }

        const { data: currentRows, error: getErr } = await supabase
            .from("workflow")
            .select("id, favorited")
            .in("id", ownedIds);

        if (getErr) throw getErr;

        const explicitFavorited = req.body?.favorited;
        const allCurrentlyFavorited = (currentRows || []).every((row) => !!row.favorited);
        const nextFavorited = explicitFavorited === undefined ? !allCurrentlyFavorited : !!explicitFavorited;

        const { data, error } = await supabase
            .from("workflow")
            .update({ favorited: nextFavorited })
            .in("id", ownedIds)
            .select("id, favorited");

        if (error) throw error;

        return res.json({
            ok: true,
            workflow_ids: ownedIds,
            count: ownedIds.length,
            favorited: nextFavorited,
            workflows: data || [],
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

        if (!(await verifyWorkflowOwnership(id, userId))) {
            return res.status(403).json({ ok: false, message: "Unauthorized access to this workflow" });
        }

        if (session_id) {
            // Verify target session ownership
            const { data: session } = await supabase
                .from("session")
                .select("id, project:project!project_id(user_id)")
                .eq("id", session_id)
                .single();
            if (!session || session.project?.user_id !== userId) {
                return res.status(403).json({ ok: false, message: "Unauthorized access to target session" });
            }
        }

        if (project_id) {
            // Verify target project ownership
            const { data: project } = await supabase
                .from("project")
                .select("user_id")
                .eq("id", project_id)
                .single();
            if (!project || project.user_id !== userId) {
                return res.status(403).json({ ok: false, message: "Unauthorized access to target project" });
            }
        }

        console.log(`\n📦 [moveWorkflow] Request received:`);
        console.log(`   workflow_id  : ${id}`);

        if (!session_id && !newsession) {
            return res.status(400).json({ ok: false, message: "session_id or newsession is required" });
        }

        let targetSessionId = session_id;
        let targetProjectId = project_id;
        let createdSession = null;

        // If creating a new session, we need the project ID (from body or DB)
        if (newsession) {
            if (!targetProjectId) {
                const { data: wf } = await supabase.from("workflow").select("project_id").eq("id", id).single();
                if (wf) targetProjectId = wf.project_id;
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
        }

        const updates = { session_id: targetSessionId };
        if (targetProjectId) {
            updates.project_id = targetProjectId;
        }

        const { data: workflow, error } = await supabase
            .from("workflow")
            .update(updates)
            .eq("id", id)
            .select()
            .single();

        if (error) throw error;

        // If project_id changed, cascade to child media items
        if (targetProjectId) {
            await supabase
                .from("media")
                .update({ project_id: targetProjectId })
                .eq("workflow_id", id);
        }

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
        const userId = req.user.id;

        if (!media_id) {
            return res.status(400).json({ ok: false, message: "media_id is required" });
        }

        if (!(await verifyWorkflowOwnership(id, userId))) {
            return res.status(403).json({ ok: false, message: "Unauthorized access to this workflow" });
        }

        if (!(await verifyMediaOwnership(media_id, userId))) {
            return res.status(403).json({ ok: false, message: "Unauthorized access to this media" });
        }

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
export const getWorkflowByMedia = async (req, res) => {
    try {
        const { media_id } = req.params;
        const userId = req.user.id;

        if (!media_id) return res.status(400).json({ ok: false, message: "media_id is required" });

        if (!(await verifyMediaOwnership(media_id, userId))) {
            return res.status(403).json({ ok: false, message: "Unauthorized access to this media" });
        }

        const { data: media, error: mediaErr } = await supabase
            .from("media")
            .select("id, workflow_id, project_id, status, url, create_time, error_message")
            .eq("id", media_id)
            .single();

        if (mediaErr) throw mediaErr;

        const workflowId = media.workflow_id;
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

        return res.json({ ok: true, workflow, items });
    } catch (err) {
        console.error("❌ Error fetching workflow by media:", err);
        return res.status(500).json({ ok: false, message: err.message });
    }
};

// ── POST /api/workflows/detach-media ───────────────────────────────────────────
export const detachMediaToNewWorkflow = async (req, res) => {
    try {
        const { media_id, project_id, session_id, display_name } = req.body || {};
        const userId = req.user.id;

        if (!media_id) return res.status(400).json({ ok: false, message: "media_id is required" });

        if (!(await verifyMediaOwnership(media_id, userId))) {
            return res.status(403).json({ ok: false, message: "Unauthorized access to this media" });
        }

        // Fetch media + its current workflow context
        const { data: media, error: mediaErr } = await supabase
            .from("media")
            .select("*, workflow:workflow!workflow_id(id, project_id, session_id, display_name)")
            .eq("id", media_id)
            .single();
        if (mediaErr) throw mediaErr;

        const status = (media.status || "").toString().toLowerCase();
        if (["processing", "pending", "uploading"].includes(status)) {
            return res.status(403).json({ ok: false, message: "Cannot detach media while generation is in progress" });
        }

        const currentWorkflowId = media.workflow_id;
        const inferredProjectId = media.project_id || media.workflow?.project_id;
        const inferredSessionId = media.workflow?.session_id;

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

        // Move media
        await supabase
            .from("media")
            .update({ workflow_id: newWorkflow.id, project_id: inferredProjectId })
            .eq("id", media_id);

        // Set as primary
        const { data: updatedWorkflow } = await supabase
            .from("workflow")
            .update({ primary_media_id: media_id })
            .eq("id", newWorkflow.id)
            .select("*")
            .single();

        // Fix old workflow primary if needed
        if (currentWorkflowId) {
            const { data: oldWf } = await supabase
                .from("workflow")
                .select("primary_media_id")
                .eq("id", currentWorkflowId)
                .single();
            if (oldWf?.primary_media_id === media_id) {
                const { data: remaining } = await supabase
                    .from("media")
                    .select("id")
                    .eq("workflow_id", currentWorkflowId)
                    .order("create_time", { ascending: true })
                    .limit(1);
                const nextPrimary = remaining?.[0]?.id ?? null;
                await supabase.from("workflow").update({ primary_media_id: nextPrimary }).eq("id", currentWorkflowId);
            }
        }

        return res.json({ ok: true, workflow: updatedWorkflow });
    } catch (err) {
        console.error("❌ Error detaching media to new workflow:", err);
        return res.status(500).json({ ok: false, message: err.message });
    }
};

// ── DELETE /api/workflows/media/:media_id ───────────────────────────────────────
export const deleteMedia = async (req, res) => {
    try {
        const { media_id } = req.params;
        const userId = req.user.id;

        if (!media_id) return res.status(400).json({ ok: false, message: "media_id is required" });

        if (!(await verifyMediaOwnership(media_id, userId))) {
            return res.status(403).json({ ok: false, message: "Unauthorized access to this media" });
        }

        // Clean up references
        await supabase.from("generation_config_reference").delete().eq("ref_media_id", media_id);

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
