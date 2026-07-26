import { supabase } from "../lib/supabase.js";

/** POST — create session */
export const create = async (req, res) => {
    try {
        const { session_name, name, project_id } = req.body;
        if (!project_id) return res.status(400).json({ ok: false, message: "project_id is required" });

        const userId = req.user.id;
        const sessionName = session_name || name || "Untitled";

        // Verify project ownership
        const { data: project } = await supabase
            .from("project")
            .select("user_id")
            .eq("id", project_id)
            .single();

        if (!project) {
            return res.status(404).json({ ok: false, message: "Project not found" });
        }

        if (project.user_id && project.user_id !== userId) {
            if (process.env.NODE_ENV !== "production" || process.env.DEV_AUTH_BYPASS === "true" || process.env.DEV_AUTH_BYPASS === true) {
                console.warn(`⚠️ [SessionsController] Dev access granted for user ${userId} on project ${project_id}`);
            } else {
                return res.status(403).json({ ok: false, message: "Unauthorized access to this project" });
            }
        }

        const { data, error } = await supabase
            .from("session")
            .insert([{ name: sessionName, project_id }])
            .select()
            .single();

        if (error) throw error;
        res.json({ ok: true, data: { ...data, session_id: data.id, session_name: data.name } });
    } catch (error) {
        console.error("createSession error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};

/** PATCH /:id — rename session */
export const update = async (req, res) => {
    try {
        const { id } = req.params;
        const { session_name, name } = req.body;
        const sessionName = session_name || name;
        const userId = req.user.id;

        // Verify ownership through project join
        const { data: session } = await supabase
            .from("session")
            .select("id, project:project!project_id(user_id)")
            .eq("id", id)
            .single();

        if (!session || session.project?.user_id !== userId) {
            return res.status(403).json({ ok: false, message: "Unauthorized access to this session" });
        }

        const { data, error } = await supabase
            .from("session")
            .update({ name: sessionName })
            .eq("id", id)
            .select()
            .single();

        if (error) throw error;
        res.json({ ok: true, data: { ...data, session_id: data.id, session_name: data.name } });
    } catch (error) {
        console.error("updateSession error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};

/** DELETE /:id */
export const remove = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        // Verify ownership and fetch project_id in one query
        const { data: session } = await supabase
            .from("session")
            .select("id, project_id, project:project!project_id(user_id)")
            .eq("id", id)
            .single();

        if (!session || session.project?.user_id !== userId) {
            return res.status(403).json({ ok: false, message: "Unauthorized access to this session" });
        }

        // Count remaining sessions for this project
        const { count } = await supabase
            .from("session")
            .select("id", { count: "exact", head: true })
            .eq("project_id", session.project_id);

        let replacementSession = null;

        // If this is the last session, create a replacement before deleting
        if (count <= 1) {
            const { data: newSession, error: newSessionError } = await supabase
                .from("session")
                .insert([{ name: "Untitled", project_id: session.project_id }])
                .select()
                .single();

            if (newSessionError) {
                console.error("Auto-session creation error:", newSessionError);
                return res.status(500).json({ ok: false, message: "Could not create replacement session" });
            }
            replacementSession = newSession;
        }

        const { error } = await supabase
            .from("session")
            .delete()
            .eq("id", id);

        if (error) throw error;

        res.json({ ok: true, replacementSession: replacementSession || null });
    } catch (error) {
        console.error("deleteSession error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};
