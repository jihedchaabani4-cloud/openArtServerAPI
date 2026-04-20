import { supabase } from "../lib/supabase.js";


/** POST — create session */
export const create = async (req, res) => {
    try {
        const { session_name, name, project_id } = req.body;
        if (!project_id) return res.status(400).json({ ok: false, message: "project_id is required" });

        const sessionName = session_name || name || "Untitled";



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
        const { error } = await supabase
            .from("session")
            .delete()
            .eq("id", id);

        if (error) throw error;
        res.json({ ok: true });
    } catch (error) {
        console.error("deleteSession error:", error);
        res.status(500).json({ ok: false, message: error.message });
    }
};
