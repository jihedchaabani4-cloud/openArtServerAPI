import { supabase } from "../lib/supabase.js";

/**
 * Get all workspaces
 */
export const getAll = async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("workspaces")
            .select("*")
            .order("created_at", { ascending: false });

        if (error) throw error;

        res.json({ ok: true, data });
    } catch (error) {
        console.error("fetchWorkspaces error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};

/**
 * Create a new workspace
 */
export const create = async (req, res) => {
    try {
        const { name } = req.body;
        if (!name) return res.status(400).json({ ok: false, message: "name is required" });

        const { data, error } = await supabase
            .from("workspaces")
            .insert([{ name }])
            .select()
            .single();

        if (error) throw error;

        res.json({ ok: true, data });
    } catch (error) {
        console.error("createWorkspace error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};

/**
 * Update workspace
 */
export const update = async (req, res) => {
    try {
        const { id } = req.params;
        const { name } = req.body;

        const { data, error } = await supabase
            .from("workspaces")
            .update({ name })
            .eq("id", id)
            .select()
            .single();

        if (error) throw error;

        res.json({ ok: true, data });
    } catch (error) {
        console.error("updateWorkspace error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};

/**
 * Delete workspace
 */
export const remove = async (req, res) => {
    try {
        const { id } = req.params;

        const { error } = await supabase
            .from("workspaces")
            .delete()
            .eq("id", id);

        if (error) throw error;

        res.json({ ok: true });
    } catch (error) {
        console.error("deleteWorkspace error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};

/**
 * Empty workspace (Delete all generations and assets)
 */
export const empty = async (req, res) => {
    try {
        const { id } = req.params;

        // 0. Get all session IDs for this project
        const { data: sessionData, error: sessionError } = await supabase
            .from("session")
            .select("session_id")
            .eq("project_id", id);
        
        if (sessionError) throw sessionError;
        
        const sessionIds = sessionData?.map(s => s.session_id) || [];

        if (sessionIds.length > 0) {
            // 1. Delete generations
            const { error: genError } = await supabase
                .from("generations")
                .delete()
                .in("session_id", sessionIds);

            if (genError) throw genError;

            // 2. Delete media assets
            const { error: assetError } = await supabase
                .from("media_assets")
                .delete()
                .in("session_id", sessionIds);

            if (assetError) throw assetError;
        }

        res.json({ ok: true });
    } catch (error) {
        console.error("emptyWorkspace error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};
