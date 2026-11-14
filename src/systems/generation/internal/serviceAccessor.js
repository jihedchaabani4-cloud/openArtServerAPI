/**
 * System 1: Generation & Workflows — Internal Service Accessor
 *
 * Configured by src/container.js at bootstrap via configureGeneration().
 */
const _services = {
    generationService: null,
    generationRequestService: null,
    workflowService: null,
    projectReadService: null,
    characterService: null,
    elementService: null,
    trashService: null,
    db: null,
};

export function setGenerationServices(services = {}) {
    if (services.generationService) _services.generationService = services.generationService;
    if (services.generationRequestService) _services.generationRequestService = services.generationRequestService;
    if (services.workflowService) _services.workflowService = services.workflowService;
    if (services.projectReadService) _services.projectReadService = services.projectReadService;
    if (services.characterService) _services.characterService = services.characterService;
    if (services.elementService) _services.elementService = services.elementService;
    if (services.trashService) _services.trashService = services.trashService;
    if (services.db) _services.db = services.db;
}

export function getGenerationServices() {
    return _services;
}
