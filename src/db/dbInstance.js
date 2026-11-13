/**
 * Dedicated DB Repositories Container Instance
 *
 * Encapsulates domain repositories into the shared `db` container.
 * Decouples database repository access from the global service container,
 * breaking circular import dependencies.
 */

import { ProjectRepository }          from "#db/ProjectRepository.js";
import { WorkflowRepository }         from "#db/WorkflowRepository.js";
import { MediaRepository }            from "#db/MediaRepository.js";
import { WorkflowMediaRepository }     from "#db/WorkflowMediaRepository.js";
import { GenerationConfigRepository } from "#db/GenerationConfigRepository.js";
import { CharacterRepository }        from "#db/CharacterRepository.js";
import { ElementRepository }          from "#db/ElementRepository.js";
import { FolderRepository }           from "#db/FolderRepository.js";
import { TrashRepository }            from "#db/TrashRepository.js";

const configRepo = new GenerationConfigRepository();

export const db = {
    projects:          new ProjectRepository(),
    workflows:         new WorkflowRepository(),
    media:             new MediaRepository(),
    workflowMedia:     new WorkflowMediaRepository(),
    configs:           configRepo,
    generationConfigs: configRepo,
    characters:        new CharacterRepository(),
    elements:          new ElementRepository(),
    folders:           new FolderRepository(),
    trash:             new TrashRepository(),
};

export default db;
