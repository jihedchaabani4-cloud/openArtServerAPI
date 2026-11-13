/**
 * Models Business System (#platform/models)
 *
 * Legacy Platform Facade Re-export.
 * Canonical gateway now lives in src/systems/models/public/tools.js (#models/tools)
 * and src/systems/models/public/api.js (#models/api).
 */

export {
    // Typed Errors (Rule 8) & Legacy Compatibility
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

    // Core Models Facade Capabilities
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

    // Inter-system tools
    validateModelInputs,
    calculateOperationCost,
    executeGeneration,
    executeLLM,

    // Pricing Service
    PricingService,

    // Platform AI, LLM & Prompt Services
    LLMService,
    llmService,
    PromptService,
} from "#models/tools";
