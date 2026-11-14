/**
 * Service Accessor for Workspace internal controllers and tools.
 */
import { ProjectService } from "./ProjectService.js";
import { FolderService } from "./FolderService.js";
import { projectRepository } from "../db/ProjectRepository.js";
import { folderRepository } from "../db/FolderRepository.js";

let _projectService = null;
let _folderService = null;
let _trashService = null;
let _generationService = null;

export function setWorkspaceServices({ projectService, folderService, trashService, generationService } = {}) {
    if (projectService) _projectService = projectService;
    if (folderService) _folderService = folderService;
    if (trashService) _trashService = trashService;
    if (generationService) _generationService = generationService;
}

export function getProjectService() {
    if (!_projectService) {
        _projectService = new ProjectService({ projectRepo: projectRepository });
    }
    return _projectService;
}

export function getFolderService() {
    if (!_folderService) {
        _folderService = new FolderService({ folderRepo: folderRepository, projectRepo: projectRepository });
    }
    return _folderService;
}

export function getTrashService() {
    return _trashService;
}

export function getGenerationService() {
    return _generationService;
}
