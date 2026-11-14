/**
 * System 1: Generation & Workflows — Internal Repository Map
 *
 * Aggregates repositories via inter-system public tools (#workspace/tools, #media/tools,
 * #characters/tools, #elements/tools) and local Generation repositories.
 * If configured by src/container.js via serviceAccessor, delegates to the container's db map.
 */
import { projectRepository, folderRepository, trashRepository } from "#workspace/tools";
import { getMediaRepository, getWorkflowMediaRepository } from "#media/tools";
import { characterRepository } from "#characters/tools";
import { elementRepository } from "#elements/tools";
import { workflowRepository } from "./WorkflowRepository.js";
import { generationConfigRepository } from "./GenerationConfigRepository.js";
import { getGenerationServices } from "../serviceAccessor.js";

const fallbackDb = {
    projects: projectRepository,
    workflows: workflowRepository,
    media: getMediaRepository(),
    workflowMedia: getWorkflowMediaRepository(),
    configs: generationConfigRepository,
    generationConfigs: generationConfigRepository,
    characters: characterRepository,
    elements: elementRepository,
    folders: folderRepository,
    trash: trashRepository,
};

export const db = new Proxy(fallbackDb, {
    get(target, prop) {
        const configuredDb = getGenerationServices().db;
        if (configuredDb && prop in configuredDb) {
            return configuredDb[prop];
        }
        return target[prop];
    },
    set(target, prop, value) {
        const configuredDb = getGenerationServices().db;
        if (configuredDb) {
            configuredDb[prop] = value;
        }
        target[prop] = value;
        return true;
    },
});

export default db;
