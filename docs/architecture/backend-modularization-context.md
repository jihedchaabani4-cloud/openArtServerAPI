# OpenArt Backend — Full Architecture & Refactoring Context

> Contains both authoritative context documents in full (unabridged):
> 1. **Part I**: `Context — Service Architecture Refactoring`
> 2. **Part II**: `Backend Modularization — Full Architecture Context`

---

# Part I: Context — Service Architecture Refactoring

## 1. Purpose

This document defines the architectural direction for refactoring the
OpenArt backend.

The goal is to transform the backend from a collection of tightly
coupled services and modules into a set of clearly separated, reusable,
independently maintainable service systems.

This is an architectural context and direction document. It is **not**
an implementation task or permission to modify code immediately.

The coding agent must first inspect the existing repository, understand
the current architecture, and produce an evidence-based audit before
proposing or applying changes.

## 2. Core vision

The target principle is:

**One Service = One Clear Responsibility = One Independent System**

Each service should own a well-defined business/domain responsibility.
Its internal implementation should be isolated from other services, and
other parts of the application should interact with it only through an
explicit public interface.

The intended outcome:

- Clear ownership: it should be obvious which service is responsible for each feature and problem.
- Easier maintenance: changes inside one service should have minimal impact on unrelated services.
- Reusability: a service should be designed so it can potentially be reused in another application or system.
- Testability: each service should be testable independently.
- Replaceability: an internal implementation can be changed without forcing consumers to change, as long as the public contract remains compatible.
- Controlled dependencies: services must not import or manipulate one another's internal implementation.

## 3. Important clarification: independent services, not unnecessary complexity

The goal is not to turn every folder or small helper into a microservice.

Do not introduce distributed systems complexity without a concrete reason. In particular, do not assume that every service immediately needs:

- Its own server or process.
- Its own database instance.
- Its own Redis instance.
- Its own deployment.
- Its own GitHub repository.

The first requirement is **logical and architectural independence**: clear boundaries, ownership, contracts, and dependency rules.

A modular monolith may be a suitable first stage. A service can later be extracted into a separate process or repository when its reuse, scaling, deployment, or operational needs justify that decision.

Repository separation and deployment separation are possible target options, not automatic requirements for every service.

## 4. Example service domains

The following are examples to investigate, not a final approved list. The agent must discover the actual domains and responsibilities in the current repository before deciding the boundaries.

### Storage Service

Owns file and media storage operations.

Possible public functions:

```js
storage.upload(...)
storage.delete(...)
storage.get(...)
storage.list(...)
```

Consumers should not need to know whether the implementation uses Supabase Storage, S3, or another provider.

### Billing Service

Owns credits, wallet operations, holds, commits, refunds, and payment-related business rules.

Possible public functions:

```js
billing.getBalance(...)
billing.createHold(...)
billing.commitHold(...)
billing.refund(...)
```

Other services must not directly manipulate Billing's internal tables or duplicate its financial rules.

### Generation Service

Owns AI generation execution and its lifecycle, including provider execution where appropriate.

Possible public functions:

```js
generation.generate(...)
generation.getStatus(...)
generation.cancel(...)
generation.retry(...)
```

The exact boundary between Generation, provider adapters, and Model Management must be established by the audit.

### Use Case Service

Owns use-case definitions/registration and use-case execution orchestration, if those responsibilities belong together after inspection.

Possible public functions:

```js
useCases.register(...)
useCases.list(...)
useCases.run(...)
useCases.getExecution(...)
useCases.cancel(...)
```

The relationship between Use Cases, Workflow Runner, workflow definitions, and execution Workers must be explicitly mapped. Do not assume they must all be one service or separate services before examining the code.

### Model Management Service

Owns model/provider metadata and configuration management.

Possible public functions:

```js
models.list(...)
models.get(...)
models.register(...)
models.updateConfig(...)
```

It should be distinguished from the actual runtime execution of a provider/model.

## 5. Every service exposes a clear public interface

Each service must define a documented set of public operations (functions), also known as its public interface or contract.

Example:

```js
await storage.upload({
  file,
  ownerId,
  metadata
});
```

The consumer calls the public function and receives a documented result or error. It should not need to know the service's internal files, database schema, provider SDK, or implementation details.

Rules:

- Expose only operations that consumers genuinely need.
- Keep internal implementation private.
- Validate inputs at the service boundary.
- Define stable input/output contracts and error behavior.
- Version contracts when compatibility requires it.
- Do not expose database clients, raw database rows, or internal repository methods as the public interface.
- Avoid consumers importing deep internal paths such as `some-service/src/internal/...`.
- Use explicit dependency injection or documented interfaces where appropriate.

## 6. Controllers, services, workers, repositories, and adapters

These are implementation components within a service boundary; they are not automatically separate services themselves.

| Component | Responsibility |
|---|---|
| Controllers | Handle incoming HTTP requests, request validation, and HTTP responses |
| Application services | Coordinate use cases and business operations |
| Domain | Own business rules and domain concepts |
| Repositories | Own persistence access for that service |
| Workers | Execute that service's background jobs |
| Adapters/providers | Integrate external systems such as Supabase, S3, Gemini, or WaveSpeed |
| Public interface | The approved functions/contracts available to other modules or applications |
| Tests/docs | Verify and explain the service independently |

Not every service needs every component. Do not create empty or unnecessary layers merely to make folder structures look consistent.

### API and controllers

The existing or future application API may remain a central HTTP entry point. Controllers can be organized by service/domain and delegate to that service's public application interface.

A service does not automatically need a separate HTTP server just because it is independent.

The architecture should keep these concepts distinct:

- HTTP Controller: receives and responds to HTTP requests.
- Service public interface: exposes the service's capabilities to other code.
- Worker: executes background work.
- SDK/client: allows another application or service to call the service.
- MCP: an optional technical protocol/adapter for MCP clients, if explicitly required.

Do not use the term MCP to mean a generic collection of functions. The intended general concept here is a **Public Interface / Service Contract**. MCP is a separate protocol and must not be introduced unless there is a real requirement for it.

## 7. Service-to-service communication

Services should communicate through explicit contracts, not by reaching into one another's internals.

Depending on the operation, suitable mechanisms may include:

- In-process function interfaces for modules in the same application.
- SDK/package interfaces for reusable code.
- REST or gRPC APIs for separately deployed services.
- Queue messages or events for asynchronous workflows.

Choose the simplest mechanism that fits the actual requirement. Do not introduce network calls, queues, or event-driven complexity when a direct interface is sufficient.

Example:

```text
Application
   |
   v
Use Case Service
   |
   +---- calls Generation public interface
   |
   +---- calls Billing public interface
   |
   +---- calls Storage public interface
```

A consumer should know what operation it can request, not how the other service implements it.

## 8. Data ownership and boundaries

Each service should own its data access and persistence rules.

Target rules:

- A service owns the tables/data and business rules that belong to its domain.
- Other services should not directly write to its tables.
- Avoid shared repositories that allow arbitrary cross-domain database access.
- Cross-service data needs should be handled through public queries, commands, events, or explicitly designed read models.
- Shared infrastructure is acceptable, but shared infrastructure must not become a place for domain logic.
- A shared database may be retained initially if ownership boundaries are enforced; separate databases are not an automatic requirement.

The audit must identify current cross-service database access and classify it by risk.

## 9. Reuse and independent repositories

A service may eventually live in its own GitHub repository if it is genuinely reusable or has independent lifecycle needs.

Before extracting a service, verify that it has:

- A clear domain boundary.
- A stable public contract.
- No hidden dependency on another application's internal source files.
- Explicit configuration and environment requirements.
- Independent tests.
- Setup and usage documentation.
- A clear persistence and infrastructure strategy.
- A defined versioning and compatibility policy.

Do not split repositories merely to create the appearance of independence. First make the boundaries real.

## 10. Refactoring approach for existing services

Do not assume every existing service should be rewritten.

For each existing service/module, classify it as one of:

- **KEEP** — responsibilities and boundaries are already clear; preserve it.
- **REFACTOR** — the responsibility is valid, but internal structure or dependencies need improvement.
- **SPLIT** — it contains multiple unrelated responsibilities that should be separated.
- **REBUILD** — the current design is fundamentally unsuitable or repeatedly causes problems, and a replacement is justified.
- **MERGE / REASSIGN** — responsibilities are duplicated or belong to another domain; justify the target ownership.

Any REBUILD decision must include evidence and explain why incremental refactoring is not sufficient.

Preserve working behavior and compatibility unless a deliberate migration plan is approved.

## 11. Required audit before implementation

The first task is a read-only architecture audit of the current backend.

The agent must:

1. Map all existing services, controllers, workers, queues, repositories, adapters, and shared modules.
2. Identify each component's actual responsibility based on code, not folder names alone.
3. Trace important execution flows across module boundaries.
4. Identify direct imports into other modules' internals.
5. Identify cross-domain database access and shared mutable state.
6. Identify duplicated business logic.
7. Identify unclear or overlapping ownership.
8. Identify which modules are reusable and which depend on OpenArt-specific assumptions.
9. Map current tests, runtime/deployment boundaries, and infrastructure dependencies.
10. Recommend target service boundaries and public interfaces.

For every significant finding, provide:

- Exact file path and relevant symbol/function.
- Line numbers where available.
- Evidence from the repository.
- Current responsibility and dependencies.
- Problem or risk.
- Recommended target ownership.
- Whether the recommendation is KEEP, REFACTOR, SPLIT, REBUILD, or MERGE / REASSIGN.

Clearly distinguish confirmed findings from assumptions or questions requiring runtime verification.

## 12. Expected audit deliverables

Produce:

1. **Current Architecture Map** — existing modules and how they communicate.
2. **Service Inventory** — each service's responsibility and internal components.
3. **Dependency Map** — which modules depend on which other modules.
4. **Problem Map** — exact locations of coupling, duplication, and unclear ownership.
5. **Target Architecture Proposal** — recommended service boundaries.
6. **Public Interface Proposal** — proposed functions and contracts for each service.
7. **Data Ownership Proposal** — domain/table ownership and cross-service access strategy.
8. **Refactoring Classification** — KEEP / REFACTOR / SPLIT / REBUILD / MERGE.
9. **Migration Plan** — safe phases, dependencies, compatibility risks, and test strategy.

Do not start implementation until the audit and proposed target architecture have been reviewed and approved.

## 13. Safety and execution constraints

Unless the user explicitly authorizes implementation:

- Do not edit source files.
- Do not create or apply database migrations.
- Do not change environment variables or infrastructure.
- Do not move folders or split repositories.
- Do not change API contracts.
- Do not perform broad automated refactors.
- Do not delete existing code.

The immediate objective is to understand the current system and propose a clear, evidence-based architecture that supports independent, maintainable, reusable services.

---

# Part II: Backend Modularization — Full Architecture Context

## 1. Project Context

I am working on the backend of my OpenArt AI-media SaaS application.

The backend currently contains multiple domains and responsibilities, including:

- Model Management
- Use Case Management and Execution
- Workflow Management and Execution
- Media Management
- Media Upload and Ingestion
- Workflow Media
- Storage
- Credits and Billing
- Authorization
- Projects
- Elements and Characters
- Queue and Background Jobs
- Other existing backend domains and infrastructure

The backend has already undergone some service-level refactoring.

Storage Service Phase has been completed and closed.

Media Service Phase has been implemented and is currently going through final verification before commit.

Workflow Service Phase has not started yet.

## 2. My Actual Long-Term Goal

My goal is NOT simply to create more services, split files, or reorganize folders.

I want to progressively transform the entire backend into a professional, well-organized, modular architecture.

The backend should be divided into clearly defined business systems or modules.

Each system must:

- Own a specific business responsibility.
- Encapsulate its internal implementation.
- Manage its own entities and business logic.
- Expose a clearly defined public interface.
- Communicate with other systems through explicit and controlled interfaces.
- Avoid exposing its internal implementation to other systems.
- Be independently understandable and maintainable.
- Be changeable internally without unnecessarily affecting other systems.

The final architecture should allow the backend to evolve without creating uncontrolled dependencies between its different business domains.

This is a long-term architecture objective, not a request to refactor the entire backend immediately.

## 3. System-Level Modularization

I want the backend to be organized into major business systems.

Examples of potential systems:

### Model Management System

Responsible for model-related business capabilities.

Potential responsibilities:

- Model catalog
- Model metadata
- Model configuration
- Model capabilities
- Model provider mapping
- Model availability
- Model execution configuration resolution

### Use Case System

Responsible for use-case-related business capabilities.

Potential responsibilities:

- Use-case registry
- Use-case configuration
- Use-case resolution
- Use-case execution orchestration
- Resolving the workflow associated with a use case

### Workflow System

Responsible for workflow-related business capabilities.

Potential responsibilities:

- Workflow management
- Workflow configuration
- Workflow execution
- Workflow lifecycle
- Workflow references
- Workflow media relationships

### Media System

Responsible for media-related business capabilities.

Potential responsibilities:

- Media records
- Media queries
- Media lifecycle
- Media metadata
- Media ownership
- Media-related business operations

### Media Upload / Ingestion

Responsible for the media ingestion pipeline.

Potential responsibilities:

- Upload processing
- Input resolution
- File validation
- File optimization
- Upload orchestration
- Upload compensation

Its responsibilities must remain clearly separated from media database ownership and physical storage ownership.

### Storage System

Responsible for physical file storage.

Potential responsibilities:

- File upload
- File deletion
- Storage key management
- Public URL resolution
- Storage provider abstraction

### Other Systems

The architecture analysis must also identify other existing business domains, such as:

- Credits and Billing
- Authorization
- Projects
- Elements
- Characters
- Queue and Background Jobs
- Other existing domains

Do not assume this list is complete.

Discover the actual systems from the current backend architecture.

Do not create a system merely because it appears in this example.

The final system boundaries must be based on the actual codebase, business responsibilities, entity ownership, and dependency relationships.

## 4. Difference Between Systems and Services

This distinction is important.

A System represents a major business domain or responsibility.

A Service is an internal component that implements a specific responsibility inside a system.

For example:

Model Management System:

- ModelCatalogService
- ModelConfigurationService
- ModelCapabilityService
- ModelProviderResolver

These services are internal components of Model Management.

They should not automatically become independent systems.

Similarly:

Media System:

- MediaService
- MediaLifecycleService
- Other appropriate internal services

The architecture should avoid creating unnecessary systems and services.

The objective is not to maximize the number of modules.

The objective is to establish clear ownership, responsibilities, and boundaries.

## 5. System Ownership

Every system must have a clearly defined ownership boundary.

For each system, identify:

1. What business domain it owns.
2. Which entities it owns.
3. Which database tables or resources belong to it.
4. Which business operations it is responsible for.
5. Which internal services it contains.
6. Which public functions it exposes.
7. Which systems it depends on.
8. Which systems are allowed to depend on it.
9. Which responsibilities must remain outside its boundary.

A system must not directly manage another system's owned entities.

For example:

Media System owns media-related records.

Workflow System owns workflow-related records and workflow-media relationships.

Storage System owns physical storage operations.

Workflow System must not directly manipulate Media System's database tables.

Media System must not become responsible for Workflow System's business logic.

Storage System must not become responsible for media database records.

Each system must delegate operations to the appropriate owner.

## 6. Public Interfaces Between Systems

This is one of the most important architectural requirements.

Systems must communicate through explicit, well-defined public interfaces.

A system should expose only the operations that other systems actually need.

For example, Model Management might expose:

- `getModel(modelId)`
- `getExecutionConfig(modelId)`
- `listAvailableModels(filters)`

Use Case System might expose:

- `getUseCase(useCaseId)`
- `resolveWorkflow(useCaseId)`
- `runUseCase(input)`

Storage System might expose:

- `upload(input)`
- `delete(key)`
- `getPublicUrl(key)`

These are illustrative examples only.

Do not treat them as the final public contracts.

The actual interfaces must be discovered and designed based on existing backend functionality.

A system's public interface must define:

- Function name
- Responsibility
- Input
- Output
- Validation expectations
- Error behavior
- Relevant authorization requirements
- Whether the operation is synchronous or asynchronous
- Any important side effects

Other systems should depend on these contracts, not on internal implementations.

## 7. Systems Must Hide Their Internal Implementation

A system must expose what it provides, not how it internally works.

For example:

Use Case System needs model execution configuration.

It should communicate with Model Management through a public interface.

Conceptually:

```js
const config = await modelManagement.getExecutionConfig(modelId);
```

Use Case System should not:

- Import Model Management repositories directly.
- Query Model Management database tables.
- Access Model Management internal services.
- Know how Model Management resolves providers.
- Reimplement Model Management business logic.

Model Management should own that implementation.

The same principle applies to every system.

A system should know:

- What operation it can request.
- What input the operation requires.
- What output it receives.
- What errors it can expect.

It should not know the internal implementation of the system providing the operation.

## 8. Internal Services Must Also Have Clear Responsibilities

The same architectural principle should apply inside each system.

For example, inside Media System:

MediaService should own media business operations.

MediaLifecycleService should own lifecycle orchestration.

MediaRepository should own database access.

The internal services should communicate through appropriate interfaces and dependency injection.

Avoid:

- Large services with unrelated responsibilities.
- Services directly accessing another service's private implementation.
- Duplicate business logic.
- Circular dependencies.
- Uncontrolled direct database access.
- Unclear ownership between services.

However, do not force every internal service to expose a public interface to the entire backend.

System-level public interfaces should be the primary communication boundary between business systems.

Internal services should remain internal unless there is a justified reason to expose them.

## 9. Dependency Direction and Communication

The architecture must have controlled dependencies.

Avoid uncontrolled relationships such as:

System A imports internal services from System B.

System B imports internal services from System A.

System C accesses repositories from Systems A and B.

This creates coupling and makes future changes difficult.

The objective is:

- Explicit dependencies.
- Clear ownership.
- Public interfaces between systems.
- Internal implementation hidden.
- No circular dependencies.
- No arbitrary cross-system imports.
- No direct access to another system's repositories.
- No duplicated business logic across systems.

The dependency direction must be designed based on actual business responsibilities.

Do not assume that every system should depend on every other system.

Do not introduce a generic shared service merely to make dependencies disappear.

Shared infrastructure should only contain genuinely shared technical capabilities.

Business logic should remain owned by its appropriate system.

## 10. Composition and Dependency Injection

The backend composition layer, such as the existing container, should be responsible for assembling the systems and their dependencies.

Systems should receive the dependencies they need through explicit injection.

Avoid systems creating arbitrary instances of other systems internally.

Avoid direct imports of implementation classes when a public interface or injected dependency is appropriate.

The architecture should make dependencies understandable from the system's constructor and composition configuration.

However, do not introduce a new dependency injection framework or rewrite the existing container without first analyzing whether it is necessary.

Use the existing backend composition architecture where appropriate.

## 11. Current Refactoring Context

The current work is still focused on service-level refactoring.

### Storage Service Phase

Storage Service Phase has already been completed and closed.

Do not reopen or modify it unless a specific architectural issue is discovered and explicitly approved.

### Media Service Phase

Media Service Phase has been implemented.

It is currently awaiting final Git verification and explicit approval before commit.

The current phase includes:

- Media ownership
- Media repository access
- Media upload and ingestion boundaries
- StorageService integration
- Legacy ingestion removal
- Media lifecycle
- Relevant workflow-to-media access corrections

The Media Phase must remain limited to its approved scope.

Do not use the broader architecture goal as permission to make additional changes during the current verification phase.

### Workflow Service Phase

Workflow Service Phase has not started.

Do not start it.

Do not modify Workflow architecture broadly.

Do not begin system-level migration.

Wait for explicit approval.

## 12. Important Difference Between the Current Phase and the Final Goal

The current work is:

Service-level refactoring inside existing backend responsibilities.

The long-term goal is:

System-level modularization across the entire backend.

These are related but different levels of architecture.

The current Storage and Media work may contribute to the future architecture, but it does not mean that the final system boundaries have already been established.

Do not assume that the current folder structure or service structure is the final system architecture.

The final architecture must be discovered and designed separately.

## 13. What I Want You to Do Now

For now, I want you to understand this architecture vision and use it as context for future work.

Do not immediately implement the entire modularization.

Do not create new systems or services.

Do not modify the current Media Phase.

Do not start Workflow Service Phase.

Do not commit anything.

The next architecture-level task, when explicitly approved, should be a comprehensive backend architecture analysis.

That analysis should discover the existing backend structure and identify:

1. Existing business domains.
2. Existing systems and modules.
3. Existing services.
4. Existing repositories.
5. Existing database ownership.
6. Existing public interfaces.
7. Existing direct cross-domain imports.
8. Existing direct cross-domain database access.
9. Existing circular dependencies.
10. Existing duplicated business logic.
11. Existing responsibilities that are mixed together.
12. Existing dependency injection and composition structure.
13. Current architecture boundaries.
14. Potential future system boundaries.
15. Migration risks.

The analysis should then propose a target architecture.

For every proposed system, document:

- System name
- Business responsibility
- Entity ownership
- Database ownership
- Internal services
- Public interface
- Dependencies
- Systems that may depend on it
- Systems it may depend on
- Responsibilities explicitly excluded from it

The analysis must distinguish:

- Current architecture
- Proposed target architecture
- Architectural problems
- Recommended migration steps

Do not present proposed architecture as already implemented.

## 14. Migration Strategy

The eventual migration should be incremental.

Do not refactor the entire backend in one large operation.

First establish the architecture and system boundaries.

Then define the migration order.

Each migration phase should:

- Have a clear scope.
- Have a defined owner.
- Preserve existing behavior.
- Define public interface changes.
- Identify affected systems.
- Include dependency and boundary checks.
- Include relevant tests.
- Include architecture gate verification.
- Be reviewed before moving to the next system.

Do not start a new system phase without explicit approval.

## 15. Final Architectural Vision

The final backend should consist of well-defined business systems.

Each system owns its domain and encapsulates its internal implementation.

Each system exposes a controlled public interface.

Other systems interact with it only through that interface.

Each system may contain internal services, repositories, and other components, but those internal components should not become uncontrolled dependencies for the rest of the backend.

The goal is a backend where:

- Every business responsibility has a clear owner.
- Every system has a clear boundary.
- Every cross-system dependency is intentional.
- Every public interface has a defined contract.
- Internal implementation can evolve independently.
- Systems do not directly manipulate each other's owned data.
- Services remain focused and cohesive.
- Circular dependencies are prevented.
- The backend can be maintained and extended without uncontrolled coupling.

This is the architectural direction I want for the entire OpenArt backend.

For now, treat this as architecture context.

Do not implement the full architecture until I explicitly approve the architecture analysis and the subsequent migration phases.
