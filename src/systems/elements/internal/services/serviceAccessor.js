import defaultInstance from "./ElementService.js";

let _elementService = null;
let _elementMediaService = null;

export function setElementServices({ elementService, elementMediaService } = {}) {
    if (elementService) _elementService = elementService;
    if (elementMediaService) _elementMediaService = elementMediaService;
}

export function getElementService() {
    return _elementService || defaultInstance;
}

export function getElementMediaService() {
    return _elementMediaService || defaultInstance.mediaService;
}
