/**
 * System 7: Elements — Internal Services Subsystem
 *
 * Encapsulates domain services for Element entity lifecycle, media management,
 * prompt building tokens, and taste profile analysis.
 */

import {
    ElementService,
    getElementContextForPrompt,
} from "../../../../domain/element/ElementService.js";
import { ElementMediaService } from "../../../../domain/element/ElementMediaService.js";
import { ElementAnalysisService } from "../../../../domain/element/ElementAnalysisService.js";
import {
    extractElementTokens,
    stripElementTokens,
    PromptBuilderProService,
} from "../../../../domain/element/promptBuilderProService.js";

export {
    ElementService,
    ElementMediaService,
    ElementAnalysisService,
    extractElementTokens,
    stripElementTokens,
    PromptBuilderProService,
    getElementContextForPrompt,
};

export default {
    ElementService,
    ElementMediaService,
    ElementAnalysisService,
    extractElementTokens,
    stripElementTokens,
    PromptBuilderProService,
    getElementContextForPrompt,
};
