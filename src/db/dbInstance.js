/**
 * Dedicated DB Repositories Container Instance
 *
 * Encapsulates domain repositories into the shared `db` container.
 * Decouples database repository access from the global service container,
 * breaking circular import dependencies.
 */

import { ProjectRepository, FolderRepository, TrashRepository } from "#workspace/tools";
import { WorkflowRepository, GenerationConfigRepository } from "#generation/tools";
import { MediaRepository, WorkflowMediaRepository } from "#media/tools";
import { CharacterRepository } from "#characters/tools";
import { ElementRepository } from "#elements/tools";

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
