/**
 * System 6: Characters — Internal Services Subsystem
 *
 * Encapsulates domain services for Character entity lifecycle, media management,
 * and character sheet generation orchestration.
 */

import { CharacterService } from "../../../../domain/character/CharacterService.js";
import {
    CharacterMediaService,
    CHARACTER_MAX_DETAIL_MEDIA,
} from "../../../../domain/character/CharacterMediaService.js";
import { CharacterGenerationService } from "../../../../domain/character/CharacterGenerationService.js";

export {
    CharacterService,
    CharacterMediaService,
    CharacterGenerationService,
    CHARACTER_MAX_DETAIL_MEDIA,
};

export default {
    CharacterService,
    CharacterMediaService,
    CharacterGenerationService,
    CHARACTER_MAX_DETAIL_MEDIA,
};
