import { supabase } from "../lib/supabase.js";
import { isModelHidden } from "../lib/modelRegistryKeys.js";

async function getOwnedProjectIds(userId, projectId = null) {
    let projectsQuery = supabase
        .from("project")
        .select("id")
        .eq("user_id", userId);

    if (projectId) {
        projectsQuery = projectsQuery.eq("id", projectId);
    }

    const { data: ownedProjects, error: projectError } = await projectsQuery;
    if (projectError) throw projectError;

    return (ownedProjects || []).map((project) => project.id).filter(Boolean);
}

async function buildLibraryPayload({ workflows = [] }) {
    const primaryMediaIds = [...new Set(
        (workflows || [])
            .map((workflow) => workflow.primary_media_id)
            .filter(Boolean)
    )];

    let primaryMediaMap = new Map();

    if (primaryMediaIds.length > 0) {
        const { data: primaryMediaRows, error: primaryMediaError } = await supabase
            .from("media")
            .select(`
                id,
                workflow_id,
                generation_config_id,
                step_id,
                url,
                width,
                height,
                status,
                error_message,
                create_time
            `)
            .in("id", primaryMediaIds);

        if (primaryMediaError) throw primaryMediaError;

        primaryMediaMap = new Map(
            (primaryMediaRows || []).map((media) => [media.id, media])
        );
    }

    const primaryMedia = (workflows || [])
        .map((workflow) => primaryMediaMap.get(workflow.primary_media_id))
        .filter(Boolean);

    const generationConfigIds = [...new Set(
        primaryMedia
            .map((media) => media.generation_config_id)
            .filter(Boolean)
    )];

    let configMap = new Map();

    if (generationConfigIds.length > 0) {
        const { data: generationConfigs, error: configError } = await supabase
            .from("generation_config")
            .select(`
                id,
                prompt,
                model,
                aspect_ratio,
                generation_type,
                seed,
                visibility,
                references:generation_config_reference!generation_config_reference_generation_config_id_fkey(
                    id,
                    position,
                    input_type,
                    ref_media_id,
                    ref_media:media(
                        id,
                        workflow_id,
                        url,
                        width,
                        height,
                        status,
                        create_time
                    )
                )
            `)
            .in("id", generationConfigIds);

        if (configError) throw configError;

        configMap = new Map(
            (generationConfigs || []).map((config) => [
                config.id,
                {
                    id: config.id,
                    prompt: config.prompt || "",
                    model: isModelHidden(config.model) ? null : (config.model || ""),
                    aspect_ratio: config.aspect_ratio || null,
                    generation_type: config.generation_type || null,
                    seed: config.seed ?? null,
                    visibility: config.visibility || "PRIVATE",
                    references: (config.references || [])
                        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
                        .map((ref) => ({
                            id: ref.id,
                            position: ref.position ?? 0,
                            input_type: ref.input_type || null,
                            ref_media_id: ref.ref_media_id || null,
                            ref_media: ref.ref_media
                                ? {
                                    id: ref.ref_media.id,
                                    workflow_id: ref.ref_media.workflow_id,
                                    url: ref.ref_media.url,
                                    width: ref.ref_media.width,
                                    height: ref.ref_media.height,
                                    status: ref.ref_media.status,
                                    create_time: ref.ref_media.create_time,
                                }
                                : null,
                        })),
                },
            ])
        );
    }

    return (workflows || []).map((workflow) => {
        const media = primaryMediaMap.get(workflow.primary_media_id) || null;
        const generationInfo = media?.generation_config_id
            ? configMap.get(media.generation_config_id) || null
            : null;

        return {
            workflow: {
                id: workflow.id,
                project_id: workflow.project_id,
                session_id: workflow.session_id,
                display_name: workflow.display_name,
                variation_index: workflow.variation_index,
                primary_media_id: workflow.primary_media_id,
                favorited: !!workflow.favorited,
                workflow_type: workflow.workflow_type || null,
                create_time: workflow.create_time,
            },
            primary_media: media
                ? {
                    id: media.id,
                    workflow_id: media.workflow_id,
                    generation_config_id: media.generation_config_id,
                    step_id: media.step_id,
                    url: media.url,
                    width: media.width,
                    height: media.height,
                    status: media.status,
                    error_message: media.error_message,
                    create_time: media.create_time,
                }
                : null,
            generation_info: generationInfo,
        };
    });
}

export const getAssets = async (req, res) => {
    try {
        const { project_id } = req.params;
        const { session_id, limit = 30, offset = 0 } = req.query;

        if (!project_id || project_id === "null") {
            return res.json({ ok: true, data: [] });
        }

        const userId = req.user.id;

        const { data: projectData, error: projectError } = await supabase
            .from("project")
            .select("user_id")
            .eq("id", project_id)
            .single();

        if (projectError || !projectData) {
            return res.status(404).json({ ok: false, message: "Project not found" });
        }

        if (projectData.user_id && projectData.user_id !== userId) {
            if (process.env.NODE_ENV !== "production" || process.env.DEV_AUTH_BYPASS === "true" || process.env.DEV_AUTH_BYPASS === true) {
                console.warn(`⚠️ [GenerationsQueryController] Dev access granted for user ${userId} on project ${project_id}`);
            } else {
                return res.status(403).json({ ok: false, message: "Unauthorized access to this project" });
            }
        }

        let query = supabase
            .from("media")
            .select("id, url, width, height, step_id, workflow_id, create_time")
            .eq("project_id", project_id)
            .order("create_time", { ascending: false })
            .range(Number(offset), Number(offset) + Number(limit) - 1);

        if (session_id) {
            query = query.eq("workflow.session_id", session_id);
        }

        const { data, error } = await query;
        if (error) throw error;

        res.json({ ok: true, data: data || [], hasMore: (data || []).length === Number(limit) });
    } catch (error) {
        console.error("getAssets error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};

export const getUserLibrary = async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            project_id = null,
            session_id = null,
            limit = 30,
            offset = 0,
        } = req.query;

        const parsedLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
        const parsedOffset = Math.max(Number(offset) || 0, 0);
        const projectIds = await getOwnedProjectIds(userId, project_id);

        if (projectIds.length === 0) {
            return res.json({ ok: true, data: [], total: 0, hasMore: false });
        }

        let totalQuery = supabase
            .from("workflow")
            .select("id", { count: "exact", head: true })
            .in("project_id", projectIds);

        if (session_id) {
            totalQuery = totalQuery.eq("session_id", session_id);
        }

        const { count: total, error: totalError } = await totalQuery;
        if (totalError) throw totalError;

        let workflowsQuery = supabase
            .from("workflow")
            .select(`
                id,
                project_id,
                session_id,
                display_name,
                variation_index,
                primary_media_id,
                favorited,
                workflow_type,
                create_time
            `)
            .in("project_id", projectIds)
            .order("create_time", { ascending: false })
            .range(parsedOffset, parsedOffset + parsedLimit - 1);

        if (session_id) {
            workflowsQuery = workflowsQuery.eq("session_id", session_id);
        }

        const { data: workflows, error: workflowsError } = await workflowsQuery;
        if (workflowsError) throw workflowsError;

        const data = await buildLibraryPayload({ workflows });

        return res.json({
            ok: true,
            data,
            total: total || 0,
            hasMore: parsedOffset + data.length < (total || 0),
        });
    } catch (error) {
        console.error("getUserLibrary error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};

export const getLibraryWorkflowDetail = async (req, res) => {
    try {
        const userId = req.user.id;
        const { workflow_id } = req.params;

        if (!workflow_id) {
            return res.status(400).json({ ok: false, message: "workflow_id is required" });
        }

        const projectIds = await getOwnedProjectIds(userId);
        if (projectIds.length === 0) {
            return res.status(404).json({ ok: false, message: "Workflow not found" });
        }

        const { data: workflow, error: workflowError } = await supabase
            .from("workflow")
            .select(`
                id,
                project_id,
                session_id,
                display_name,
                variation_index,
                primary_media_id,
                favorited,
                workflow_type,
                create_time
            `)
            .eq("id", workflow_id)
            .in("project_id", projectIds)
            .single();

        if (workflowError || !workflow) {
            return res.status(404).json({ ok: false, message: "Workflow not found" });
        }

        const [entry] = await buildLibraryPayload({ workflows: [workflow] });
        return res.json({ ok: true, data: entry || null });
    } catch (error) {
        console.error("getLibraryWorkflowDetail error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};
