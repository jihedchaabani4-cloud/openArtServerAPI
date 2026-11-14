/**
 * System 8: Workspace — ProjectService (Internal)
 * @owns System 8: Workspace — project lifecycle, naming, user scoping, and project DTO mapping.
 */
import { AppError, createLogger } from "#shared";

const logger = createLogger("workspace:project");

export class ProjectService {
    /**
     * @param {Object} deps
     * @param {import("../db/ProjectRepository.js").ProjectRepository} deps.projectRepo
     */
    constructor({ projectRepo }) {
        this.projectRepo = projectRepo;
    }

    /**
     * Returns all projects owned by the user, formatted with thumbnail URLs.
     */
    async listUserProjects(userId) {
        if (!userId) {
            throw new AppError("Authentication required", 401);
        }

        const rawProjects = await this.projectRepo.findProjectsWithThumbnails(userId);

        return (rawProjects || []).map((project) => ({
            ...project,
            name: project.project_name,
            thumbnail_url: project.media?.[0]?.url || null,
        }));
    }

    /**
     * Creates a new project with a default timestamp name if none is provided.
     */
    async createProject({ userId, name }) {
        if (!userId) {
            throw new AppError("Authentication required", 401);
        }

        let resolvedName = name ? String(name).trim() : "";
        if (!resolvedName) {
            const now = new Date();
            resolvedName = now.toLocaleString("fr-FR", {
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
            });
        }

        const data = await this.projectRepo.insertProject({
            projectName: resolvedName,
            userId,
        });

        logger.info({ userId, projectId: data.id }, "Project created");

        return {
            ...data,
            name: data.project_name,
        };
    }

    /**
     * Updates an owned project's name. Throws 404 if project does not exist or belongs to another user.
     */
    async updateProject({ id, userId, name }) {
        if (!userId) {
            throw new AppError("Authentication required", 401);
        }
        if (!id) {
            throw new AppError("Project ID is required", 400);
        }

        const existing = await this.projectRepo.findOwnedProject(id, userId);
        if (!existing) {
            logger.warn({ userId, projectId: id }, "Foreign or non-existent project update denied");
            throw new AppError("Project not found", 404);
        }

        const updated = await this.projectRepo.updateProjectName(id, userId, String(name || "").trim());

        return {
            ...updated,
            name: updated.project_name,
        };
    }

    /**
     * Deletes an owned project. Throws 404 if project does not exist or belongs to another user.
     */
    async deleteProject({ id, userId }) {
        if (!userId) {
            throw new AppError("Authentication required", 401);
        }
        if (!id) {
            throw new AppError("Project ID is required", 400);
        }

        const existing = await this.projectRepo.findOwnedProject(id, userId);
        if (!existing) {
            logger.warn({ userId, projectId: id }, "Foreign or non-existent project delete denied");
            throw new AppError("Project not found", 404);
        }

        await this.projectRepo.deleteOwnedProject(id, userId);
        logger.info({ userId, projectId: id }, "Project deleted");

        return { ok: true };
    }
}
export default ProjectService;
