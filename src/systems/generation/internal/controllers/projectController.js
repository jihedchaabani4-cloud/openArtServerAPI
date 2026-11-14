import { getGenerationServices } from "../services/serviceAccessor.js";
import { getModelConfig } from "#models/tools";
import { createLogger } from "#shared";

const logger = createLogger("project_controller");

// ── GET /workflows/project-data/:project_id ───────────────────────────────────
// Thin HTTP adapter — delegates all aggregation to ProjectReadService

export const getProjectData = async (req, res) => {
    try {
        const { project_id } = req.params;
        const modelConfig    = getModelConfig();

        if (!project_id || project_id === "null" || project_id === "undefined") {
            return res.json({
                result: { data: { json: {
                    projectContents: { sessions: [], workflows: [], trashedWorkflows: [], media: [], folders: [], collections: [] },
                    folders: [],
                    collections: [],
                    modelConfig,
                    appConfig: {
                        changeLogId: "2026-03-19-v1-3f4e036c-6a67-467f-a0e6-25cff0a0a8ab",
                    },
                }}},
            });
        }

        const userId = req.user.id;

        // Delegate to ProjectReadService — all business logic lives there
        const { projectReadService } = getGenerationServices();
        const data = await projectReadService.getProjectData({ projectId: project_id, userId });

        return res.json({
            result: {
                data: {
                    json: {
                        projectName:  data.projectName,
                        projectId:    project_id,
                        appConfig:    data.appConfig,
                        modelConfig,
                        folders:      data.folders || [],
                        collections:  data.collections || data.folders || [],
                        projectContents: {
                            sessions:   data.sessions || [],
                            workflows:  data.workflows,
                            trashedWorkflows: data.trashedWorkflows || [],
                            media:      data.media,
                            elements:   data.elements,
                            characters: data.characters,
                            folders:    data.folders || [],
                            collections: data.collections || data.folders || [],
                        },
                    },
                },
            },
        });

    } catch (err) {
        const statusCode = err.statusCode || 500;
        logger.error({ event: "project_controller.getProjectData_error", err: err?.message || String(err), statusCode }, "Error fetching project data");
        res.status(statusCode).json({ ok: false, message: err.message });
    }
};
