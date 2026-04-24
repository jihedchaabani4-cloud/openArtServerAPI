import { supabase } from "../lib/supabase.js";

/** GET all projects for the authenticated user */
export const getAll = async (req, res) => {
    try {
        const userId = req.user.id;

        const { data, error } = await supabase
            .from("project")
            .select(`
                *,
                media:media(url, create_time)
            `)
            .eq("user_id", userId)
            .order("create_time", { ascending: false })
            .order("create_time", { foreignTable: "media", ascending: false })
            .limit(1, { foreignTable: "media" });

        if (error) throw error;

        // Map latest media to thumbnail_url and ensure 'name' exists for UI
        const projectsWithThumbnails = (data || []).map(project => ({
            ...project,
            name: project.project_name, // Map for UI consistency
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
        const userId = req.user.id;
        
        // 📅 Generate automatic name like: 18 avr., 12:25
        const now = new Date();
        const autoProjectName = now.toLocaleString('fr-FR', {
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
        });

        const { data, error } = await supabase
            .from("project")
            .insert([{ 
                project_name: autoProjectName,
                user_id: userId 
            }])
            .select()
            .single();

        if (error) throw error;

        // 🚀 Automatically create an "Untitled" session for the new project
        const { error: sessionError } = await supabase
            .from("session")
            .insert([{ 
                name: "Untitled", 
                project_id: data.id 
            }]);

        if (sessionError) {
            console.error("Auto-session creation error:", sessionError);
            // We don't necessarily want to fail the whole project creation if session fails,
            // but for consistency we might. Let's just log it for now or throw if critical.
        }

        res.json({ 
            ok: true, 
            data: { 
                ...data, 
                name: data.project_name 
            } 
        });
    } catch (error) {
        console.error("createProject error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};

/** PATCH /:id — rename project */
export const update = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;
        const { name, project_name } = req.body;
        const projectName = name || project_name;

        const { data, error } = await supabase
            .from("project")
            .update({ 
                project_name: projectName 
            })
            .eq("id", id)
            .eq("user_id", userId) // Ensure ownership
            .select()
            .single();

        if (error) throw error;
        res.json({ 
            ok: true, 
            data: { 
                ...data, 
                name: data.project_name 
            } 
        });
    } catch (error) {
        console.error("updateProject error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};

/** DELETE /:id */
export const remove = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const { error } = await supabase
            .from("project")
            .delete()
            .eq("id", id)
            .eq("user_id", userId); // Ensure ownership

        if (error) throw error;
        res.json({ ok: true });
    } catch (error) {
        console.error("deleteProject error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};
