import { supabase } from "./supabase.js";

/**
 * Ensures a project and session exist for a generation.
 * New schema: projects(id, project_name, user_id), sessions(id, name, project_id)
 */
export const autoCreateProjectAndSession = async (userId, projectId, sessionId, isNewProject = false) => {
    let finalProjectId = projectId;
    let finalSessionId = sessionId;

    // 1. Ensure Project
    const needsProject = isNewProject || !finalProjectId || finalProjectId === 'null' || finalProjectId === 'undefined';

    if (needsProject) {
        const { data: existingProject } = await supabase
            .from("project")
            .select("id")
            .eq("user_id", userId)
            .eq("project_name", "My Studio")
            .maybeSingle();

        if (existingProject && !isNewProject) {
            finalProjectId = existingProject.id;
        } else {
            const { data: newProject, error: createError } = await supabase
                .from("project")
                .insert([{ project_name: "My Studio", user_id: userId }])
                .select()
                .single();
            if (createError) throw new Error(`Failed to create project: ${createError.message}`);
            finalProjectId = newProject.id;
        }
    }

    // 2. Ensure Session
    const needsSession = isNewProject || !finalSessionId || finalSessionId === 'null' || finalSessionId === 'undefined';

    if (needsSession) {
        const { count } = await supabase
            .from("session")
            .select("*", { count: "exact", head: true })
            .eq("project_id", finalProjectId);

        const sessionIndex = (count || 0) + 1;
        const defaultName  = `Session ${sessionIndex}`;

        const { data: newSession, error: sessionError } = await supabase
            .from("session")
            .insert([{
                name:       defaultName,
                project_id: finalProjectId,
                position:   (count || 0),
            }])
            .select()
            .single();
        if (sessionError) throw new Error(`Failed to create session: ${sessionError.message}`);
        finalSessionId = newSession.id;
    }

    return { project_id: finalProjectId, session_id: finalSessionId };
};

