import { AppError, createLogger } from "#shared";
import { getProjectService, getGenerationService } from "../services/serviceAccessor.js";

const logger = createLogger("workspace:projects_controller");

function handleError(res, error, operation) {
    if (error instanceof AppError) {
        return res.status(error.statusCode).json({
            ok: false,
            errorCode: error.errorCode || "APP_ERROR",
            message: error.message,
        });
    }
    logger.error({ event: `projects_controller.${operation}_error`, err: error?.message || String(error) }, `${operation} error`);
    return res.status(500).json({ ok: false, message: error?.message || "Internal server error" });
}

/** GET all projects for the authenticated user */
export const getAll = async (req, res) => {
    try {
        const userId = req.user?.id;
        const projectService = getProjectService();
        const projectsWithThumbnails = await projectService.listUserProjects(userId);
        return res.json({ ok: true, data: projectsWithThumbnails });
    } catch (error) {
        return handleError(res, error, "fetchProjects");
    }
};

/** POST — create project */
export const create = async (req, res) => {
    try {
        const userId = req.user?.id;
        const name = req.body?.name || req.body?.project_name;
        const projectService = getProjectService();
        const data = await projectService.createProject({ userId, name });
        return res.json({ ok: true, data });
    } catch (error) {
        return handleError(res, error, "createProject");
    }
};

/** PATCH /:id — rename project */
export const update = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user?.id;
        const name = req.body?.name || req.body?.project_name;
        const projectService = getProjectService();
        const data = await projectService.updateProject({ id, userId, name });
        return res.json({ ok: true, data });
    } catch (error) {
        return handleError(res, error, "updateProject");
    }
};

/** DELETE /:id */
export const remove = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user?.id;
        const projectService = getProjectService();
        await projectService.deleteProject({ id, userId });
        return res.json({ ok: true });
    } catch (error) {
        return handleError(res, error, "deleteProject");
    }
};

/**
 * GET /api/projects/:projectId/assets
 * Lists assets for a project with optional folder filtering and cursor-based pagination.
 * Task F-T7 (Scenario 9).
 */
export const listAssets = async (req, res, next) => {
    try {
        const { projectId } = req.params;
        const userId = req.user?.id;
        const { folderId, includeDescendants, limit, cursor } = req.query;

        const generationService = getGenerationService();
        if (!generationService) {
            return res.status(500).json({ ok: false, message: "GenerationService not initialized" });
        }

        const result = await generationService.listProjectAssets({
            userId,
            projectId,
            folderId,
            includeDescendants,
            limit,
            cursor,
        });

        return res.status(200).json(result);
    } catch (err) {
        if (err instanceof AppError) {
            return res.status(err.statusCode).json({
                ok: false,
                errorCode: err.errorCode || "APP_ERROR",
                message: err.message,
            });
        }
        return next(err);
    }
};
