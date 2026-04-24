import { supabase } from "../lib/supabase.js";

// ─── GET /assets/:project_id ─────────────────────────────────────────────────
// Lightweight flat list of all media in a project (for asset picker).
export const getAssets = async (req, res) => {
    try {
        const { project_id } = req.params;
        const { session_id, limit = 30, offset = 0 } = req.query;

        if (!project_id || project_id === "null") {
            return res.json({ ok: true, data: [] });
        }

        const userId = req.user.id;

        // Verify ownership
        const { data: projectData, error: projectError } = await supabase
            .from("project")
            .select("user_id")
            .eq("id", project_id)
            .single();

        if (projectError || !projectData) {
            return res.status(404).json({ ok: false, message: "Project not found" });
        }

        if (projectData.user_id !== userId) {
            return res.status(403).json({ ok: false, message: "Unauthorized access to this project" });
        }

        let query = supabase
            .from("media")
            .select("id, url, width, height, step_id, workflow_id, create_time")
            .eq("project_id", project_id)
            .order("create_time", { ascending: false })
            .range(Number(offset), Number(offset) + Number(limit) - 1);

        if (session_id) {
            // Filter via workflow join
            query = query.eq("workflow.session_id", session_id);
        }

        const { data, error } = await query;
        if (error) throw error;

        res.json({ ok: true, data: data || [], hasMore: (data || []).length === Number(limit) });
    } catch (error) {
        console.error("❌ getAssets error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};

