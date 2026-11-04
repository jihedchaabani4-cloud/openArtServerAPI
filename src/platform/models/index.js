/**
 * Models Business System (#platform/models)
 *
 * Public surface for model registry, catalog presentation, parameter validation,
 * execution planning, pricing calculations, provider runtime execution,
 * and platform LLM / Prompt services.
 */

// Typed Errors (Rule 8) & Legacy Compatibility
export {
    ModelsError,
    ModelsValidationError,
    ModelsNotFoundError,
    ModelsConfigurationError,
    ModelsProviderError,
    ModelsSystemError,
    ValidationError,
    InvalidEnumValueError,
    UnknownParameterError,
    MissingOptionError,
    ProviderTransientError,
    ProviderRequestError,
    ProviderContentPolicyError,
    ProviderMalformedResponseError,
    OutputContractViolationError,
    UnsupportedCapabilityError,
    UnknownModelFamilyError,
    ModelNotFoundError,
    UnknownOperationError,
    OperationNotFoundError,
    BindingNotFoundError,
    BindingModelMismatchError,
    BindingOperationMismatchError,
    ConfigIntegrityError,
    NoEligibleBindingError,
} from "./ModelsErrors.js";

// Core Models Facade Capabilities
export {
    getCatalog,
    getModelSchema,
    getSchema,
    validateInput,
    calculateCost,
    estimatePrice,
    run,
    initRegistry,
    reloadRegistry,
    getRegistryStats,
    getModelConfig,
} from "../../models/index.js";

// Pricing Service
export {
    PricingService,
} from "../../models/pricing/PricingService.js";

// Platform AI, LLM & Prompt Services
export {
    LLMService,
    llmService,
} from "../ai/LLMService.js";

export {
    PromptService,
} from "../ai/PromptService.js";
