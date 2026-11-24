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
    executionEngine: null,
    db: null,
};

export function setGenerationServices(services = {}) {
    for (const key of Object.keys(_services)) {
        if (services[key]) _services[key] = services[key];
    }
}

export function getGenerationServices() {
    return _services;
}

export function getExecutionEngine() {
    return _services.executionEngine;
}

export function getDefaultDb() {
    return _services.db;
}
