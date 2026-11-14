# Handoff Report — Partie 05: System 2 — Models Management (`src/systems/models/`)

> **Application**: `apiOpenArt` (Labveil AI Studio Backend)  
> **Branch**: `refactory-new-arch`  
> **Status**: COMPLETED & VERIFIED  
> **Date**: 2026-11-13  
> **Quality Gate Status**: PASS (1,418 tests passing, 0 failures, 0 arch-check violations)

---

## 1. Objectives Completed

In this phase, we constructed **System 2: Models Management** (`src/systems/models/`), encapsulating the AI model registry, canonical parameter validation schemas, pure financial pricing calculation, and AI provider runtime adapters (`WaveSpeed`, `Google GenAI`, `LLMService`) into a strictly bounded modular monolith system per `01_business_systems_architecture.md` and `02_architecture_rules_and_agent_guardrails.md`.

1. **Ticket 5.1: Model Schemas, Registry & Pricing Calculation (`internal/registry/`, `internal/pricing/`, `internal/errors.js`)**
   - Implemented typed error hierarchy extending `AppError` from `#shared`: `ModelsError`, `ModelsValidationError` (400), `ModelsNotFoundError` (404), `ModelsConfigurationError` (500), `ModelsProviderError` (502), and preserved re-exports of legacy error classes for 100% backward compatibility.
   - Encapsulated internal registry subsystem in `src/systems/models/internal/registry/index.js`:
     - Manifest loading, dynamic model resolution (`initRegistry`, `getRegistry`, `getModel`, `reloadRegistry`).
     - Binding resolution (`resolveExecutionPlan`, `resolveConfiguredBinding`).
     - Schema validation (`validateCanonicalInput`, `validateBindingConstraints`, `getModelSchemaInternal`).
     - Presentation model formatting (`getModelConfig`).
   - Encapsulated pure pricing calculation in `src/systems/models/internal/pricing/index.js` (Rule 10: Model pricing calculation strictly decoupled from Billing's wallet ledger):
     - `calculateRetailCredits`, `calculateWholesaleCostUsd`, `calculateMargin`.
     - `calculateCost`, `getCatalog`, `estimatePrice`.
     - `PricingService` (DI-based caching and rule lookup).

2. **Ticket 5.2: AI Provider Resolvers & Execution Adapters (`internal/providers/`, `internal/execution/`)**
   - Encapsulated provider resolvers and adapters in `src/systems/models/internal/providers/index.js`:
     - `WaveSpeedImageResolver` and domain resolvers (`resolveWaveSpeedRoute`, `resolveWaveSpeedImageRoute`).
     - Runtime provider execution registry (`resolveProviderRoute`, `registerProviderResolver`, `getRunner`, `executeProvider`).
     - Credential resolvers (`resolveCredential`).
     - Platform AI & Multimodal Vision services (`LLMService`, `llmService`, `PromptService`).
   - Encapsulated execution engine in `src/systems/models/internal/execution/index.js`:
     - Universal Model Runner (`run`).
     - Circuit breaker registry (`circuitBreakerRegistry`).
     - Error normalization (`normalizeError`).
     - Runtime executor (`defaultRuntimeExecutor`) and idempotency store (`idempotencyStore`).

3. **Ticket 5.3: Public Gateways, Package Subpath Imports, Legacy Re-exports & Tests (`public/`, `package.json`)**
   - Created pure DTO Tools Gateway: `src/systems/models/public/tools.js` (`#models/tools`):
     - `getModelConfig(modelIdOrOptions)`: retrieves single model or full catalog config.
     - `validateModelInputs(modelId, params)`: sanitizes parameters against canonical model schema.
     - `calculateOperationCost({ modelId, operation, params })`: returns pure financial cost estimate DTO decoupled from wallet ledger.
     - `executeGeneration({ modelId, prompt, params, references, userId })`: executes generation through Universal Model Runner.
     - `executeLLM({ model, prompt, systemInstruction, images, schema, jsonMode, userId })`: executes unified LLM generation.
     - Re-exports of facade functions and typed errors for 100% backward compatibility.
   - Created Express HTTP Gateway: `src/systems/models/public/api.js` (`#models/api`):
     - `GET /`: catalog presentation with domain/category filter, DTO mapping, and grouping.
     - `GET /:key`: single model detail DTO.
     - `GET /:key/schema`: canonical parameter contract.
     - `POST /:key/estimate-price`: canonical price estimation.
     - `POST /admin/reload`: admin registry and pricing cache reload with live stats.
     - Preserved legacy deprecated endpoints: `GET /:key/:operation/schema` and `POST /:key/:operation/estimate-price`.
   - Registered `#models/api` and `#models/tools` in `package.json#imports` (Rule 15).
   - Maintained backward compatibility via legacy re-exports:
     - `src/platform/models/index.js` -> re-exports from `#models/tools`.
     - `routes/modelsRoute.js` -> re-exports router and `formatModelDto` from `#models/api`.
   - Added comprehensive hermetic unit test suite: `tests/unit/modelsSystem.test.js` (13 passing tests).

---

## 2. Verification & Quality Gates

| Gate Check | Command | Result |
| :--- | :--- | :--- |
| **Hermetic Test Suite** | `npm test` | **PASS**: 1,418 tests passing, 0 failures, 0 skipped |
| **Architecture Ratchet** | `npm run arch` | **PASS**: 0 new violations across R1-R15 |
| **Cycle Detector** | `node scripts/arch-check.cjs` | **PASS**: 0 static import cycles (R14 clean) |
| **Package Imports** | `node scripts/arch-check.cjs` | **PASS**: 0 alias violations (R15 clean) |
| **Documentation Paths** | `node scripts/check-doc-paths.cjs` | **PASS**: 27 references checked in 12 docs |
| **Service Catalog** | `npm run catalog` | **PASS**: `docs/agents/service-catalog.md` generated |
| **Full Gate Script** | `npm run gate` | **PASS**: All checks green |

---

## 3. Extensibility Pattern Established

To add a new AI model or provider in the future (e.g. Kling, Veo, ElevenLabs):
1. Add the model manifest to `src/models/manifests/<model>.json`.
2. Register provider binding / route in `src/systems/models/internal/providers/`.
3. Model pricing rules are automatically derived or updated without touching Billing, Generation, or any other system.

---

## 4. Next Phase Readiness

- **Next Phase**: **Partie 06: System 6 — Characters (`src/systems/characters/`)**
- Refactor Character Domain & Controller (currently 0.05 cohesion) into a clean, high-cohesion Business System managing Character CRUD, traits, and reference media via `#media/tools`.
- Deprecate and route direct generation calls from `CharacterGenerationService` to System 1 (`generation`).
