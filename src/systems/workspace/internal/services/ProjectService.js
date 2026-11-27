/**
 * System 8: Workspace — ProjectService (Internal)
 * @owns System 8: Workspace — project lifecycle, naming, user scoping, and project DTO mapping.
 */
import { createLogger } from "#shared";
import { hasInFlightMedia, MediaConflictError } from "#media/tools";
import {
    WorkspaceError,
    WorkspaceValidationError,
    WorkspaceNotFoundError,
} from "../errors.js";

const logger = createLogger("workspace:project");

export class ProjectService {
    /**
     * @param {Object} deps
     * @param {import("../db/ProjectRepository.js").ProjectRepository} deps.projectRepo
     * @param {Object|null} [deps.mediaRepo=null]
     */
    constructor({ projectRepo, mediaRepo = null }) {
        this.projectRepo = projectRepo;
        this.mediaRepo = mediaRepo;
    }

    /**
     * Returns all projects owned by the user, formatted with thumbnail URLs.
     */
    async listUserProjects(userId) {
        if (!userId) {
            throw new WorkspaceError("UNAUTHORIZED", "Authentication required", { statusCode: 401, category: "USER_FAULT" });
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
            throw new WorkspaceError("UNAUTHORIZED", "Authentication required", { statusCode: 401, category: "USER_FAULT" });
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
            throw new WorkspaceError("UNAUTHORIZED", "Authentication required", { statusCode: 401, category: "USER_FAULT" });
        }
        if (!id) {
            throw new WorkspaceValidationError("Project ID is required", { field: "id" });
        }

        const existing = await this.projectRepo.findOwnedProject(id, userId);
        if (!existing) {
            logger.warn({ userId, projectId: id }, "Foreign or non-existent project update denied");
            throw new WorkspaceNotFoundError("Project not found", { resourceId: id });
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
            throw new WorkspaceError("UNAUTHORIZED", "Authentication required", { statusCode: 401, category: "USER_FAULT" });
        }
        if (!id) {
            throw new WorkspaceValidationError("Project ID is required", { field: "id" });
        }

        const existing = await this.projectRepo.findOwnedProject(id, userId);
        if (!existing) {
            logger.warn({ userId, projectId: id }, "Foreign or non-existent project delete denied");
            throw new WorkspaceNotFoundError("Project not found", { resourceId: id });
        }

        if (this.mediaRepo) {
            let hasInFlight = false;
            if (typeof this.mediaRepo.hasInFlightMediaByProjectId === "function") {
                hasInFlight = await this.mediaRepo.hasInFlightMediaByProjectId(id);
            } else if (typeof this.mediaRepo.findByProjectAll === "function") {
                const projectMedia = await this.mediaRepo.findByProjectAll(id);
                hasInFlight = hasInFlightMedia(projectMedia);
            }
            if (hasInFlight) {
                throw new MediaConflictError("Cannot delete project while media is still processing", {
                    context: { projectId: id },
                });
            }
        }

        await this.projectRepo.deleteOwnedProject(id, userId);
        logger.info({ userId, projectId: id }, "Project deleted");

        return { ok: true };
    }
}
export default ProjectService;
