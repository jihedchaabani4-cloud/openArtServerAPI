# CONTEXT.md — apiOpenArt Architecture Context & State

## 1. Project Identity
- **Application**: `apiOpenArt` (Labveil AI Studio Backend)
- **Current Branch**: `refactory-new-arch`
- **Architecture Standard**: Strict Modular Monolith (Shopify Packwerk style) governed by:
  - `docs/architecture/constitution/01_business_systems_architecture.md` (The 8 Business Systems)
  - `docs/architecture/constitution/02_architecture_rules_and_agent_guardrails.md` (The 12 Architecture Rules)
  - `docs/architecture/constitution/03_software_factory_master_prompt_and_plan.md` (Software Factory Plan)

## 2. Active Phase: Partie 01 (COMPLETED) -> Ready for Partie 02
- **Goal**: Consolidate pure technical kernel (`src/shared/`) containing zero domain or database logic.
- **Results**:
  - `src/shared/errors/` established with hybrid AppError, specialized subclasses, and pure sanitizers.
  - `src/shared/logger/` established with AsyncLocalStorage context propagation and Pino structured logging.
  - `src/shared/config/` established with pure environment flags.
  - `src/shared/redis/` established with resilient Upstash/BullMQ connection singletons.
  - `#shared` and `#shared/*` registered in `package.json#imports`.
  - 100% backward compatibility maintained across legacy paths.
- **Suite Status**: 1,372 tests passing (0 failures), Gate PASS.

## 3. Active Tickets Roadmap
- [x] **Ticket 1.1**: Base Error Hierarchy & Runtime Error Processor (`src/shared/errors/`) [DONE]
- [x] **Ticket 1.2**: Structured Logging & Tracing Infrastructure (`src/shared/logger/`) [DONE]
- [x] **Ticket 1.3**: Pure Technical Config & Redis Connection Kernel (`src/shared/config/`, `src/shared/redis/`, `#shared`) [DONE]
