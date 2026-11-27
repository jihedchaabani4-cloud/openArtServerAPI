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
  workflowDispatcher: null,
  markMediaFailed: null,
  workflowAdapters: null,
  db: null,
};

export function setGenerationServices(services = {}) {
  for (const key of Object.keys(_services)) {
    if (key in services) {
      _services[key] = services[key];
    }
  }
}

export function getGenerationServices() {
  return _services;
}

export function getWorkflowDispatcher() {
  return _services.workflowDispatcher;
}

export function getMarkMediaFailed() {
  return _services.markMediaFailed;
}

export function getWorkflowAdapters() {
  return _services.workflowAdapters;
}
