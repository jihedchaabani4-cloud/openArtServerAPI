let _characterService = null;
let _characterMediaService = null;
let _trashService = null;

export function setCharacterServices({ characterService, characterMediaService, trashService } = {}) {
    if (characterService) _characterService = characterService;
    if (characterMediaService) _characterMediaService = characterMediaService;
    if (trashService) _trashService = trashService;
}

export function getCharacterService() {
    return _characterService;
}

export function getCharacterMediaService() {
    return _characterMediaService;
}

export function getTrashService() {
    return _trashService;
}
