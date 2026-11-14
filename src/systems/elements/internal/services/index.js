/**
 * System 7: Elements — Internal Services Subsystem
 *
 * Encapsulates domain services for Element entity lifecycle, media management,
 * prompt building tokens, and taste profile analysis.
 */

import {
    ElementService,
    getElementContextForPrompt,
} from "./ElementService.js";
import { ElementMediaService } from "./ElementMediaService.js";
import { ElementAnalysisService } from "./ElementAnalysisService.js";
import promptBuilderProService, {
    extractElementTokens,
    stripElementTokens,
    PromptBuilderProService,
} from "./promptBuilderProService.js";

export {
    ElementService,
    ElementMediaService,
    ElementAnalysisService,
    extractElementTokens,
    stripElementTokens,
    PromptBuilderProService,
    promptBuilderProService,
    getElementContextForPrompt,
};

export default {
    ElementService,
    ElementMediaService,
    ElementAnalysisService,
    extractElementTokens,
    stripElementTokens,
    PromptBuilderProService,
    promptBuilderProService,
    getElementContextForPrompt,
};
