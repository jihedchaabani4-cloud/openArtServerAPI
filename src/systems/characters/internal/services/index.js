/**
 * System 6: Characters — Internal Services Subsystem
 *
 * Encapsulates domain services for Character entity lifecycle, media management,
 * and AI turnaround sheet generation.
 */

import { CharacterService } from "./CharacterService.js";
import {
    CharacterMediaService,
    CHARACTER_MAX_DETAIL_MEDIA,
} from "./CharacterMediaService.js";
import { CharacterGenerationService } from "./CharacterGenerationService.js";

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
