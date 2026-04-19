import { supabase } from "../lib/supabase.js";

/** GET all projects */
export const getAll = async (req, res) => {
    try {
        const { data, error } = await supabase
            .from("project")
            .select(`
                *,
                media:media(url, create_time)
            `)
            .order("create_time", { ascending: false })
            .order("create_time", { foreignTable: "media", ascending: false })
            .limit(1, { foreignTable: "media" });

        if (error) throw error;

        // Map latest media to thumbnail_url
        const projectsWithThumbnails = (data || []).map(project => ({
            ...project,
            thumbnail_url: project.media?.[0]?.url || null
        }));

        res.json({ ok: true, data: projectsWithThumbnails });
    } catch (error) {
        console.error("fetchProjects error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};

/** POST — create project */
export const create = async (req, res) => {
    try {
        const { name, project_name } = req.body;
        const projectName = name || project_name;
        if (!projectName) return res.status(400).json({ ok: false, message: "name is required" });

        const { data, error } = await supabase
            .from("project")
            .insert([{ name: projectName }])
            .select()
            .single();

        if (error) throw error;
        res.json({ ok: true, data });
    } catch (error) {
        console.error("createProject error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};

/** PATCH /:id — rename project */
export const update = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, project_name } = req.body;
        const projectName = name || project_name;

        const { data, error } = await supabase
            .from("project")
            .update({ name: projectName })
            .eq("id", id)
            .select()
            .single();

        if (error) throw error;
        res.json({ ok: true, data });
    } catch (error) {
        console.error("updateProject error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};

/** DELETE /:id */
export const remove = async (req, res) => {
    try {
        const { id } = req.params;
        const { error } = await supabase
            .from("project")
            .delete()
            .eq("id", id);

        if (error) throw error;
        res.json({ ok: true });
    } catch (error) {
        console.error("deleteProject error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};
