# GLOSSARY.md — Universal Modular Monolith Domain Terminology

This glossary defines the authoritative domain terminology across all 8 Business Systems in `apiOpenArt`.

## Architecture & Structural Concepts

### Business System
A self-contained domain or platform black-box module located in `src/systems/<name>/`. Exposes functionality exclusively via `public/api.js` (HTTP Web Gateway) and/or `public/tools.js` (System Tools Interface). All other code lives strictly inside `internal/`.

### Web Gateway (`public/api.js`)
An Express router exposing HTTP endpoints (`req, res`) mounted directly by the Main Router (`src/app.js`). Responsible only for auth extraction, request DTO validation, calling internal services, and formatting HTTP responses.

### Tools Interface (`public/tools.js`)
A contract of pure, async JavaScript/TypeScript functions exposed to other Business Systems and background workers. Takes and returns plain JSON-serializable DTOs only.

### Internal (`internal/`)
Strictly private domain logic, repositories, database queries, and validators of a Business System. External files are forbidden from importing anything inside `internal/`.

### Main Router (`src/app.js` / `src/routes.js`)
The single HTTP entry point mounting system `public/api.js` routers and global middlewares. Contains zero business logic and zero DB calls.

---

## Domain & Operational Concepts

### Two-Phase Credit Hold
A financial safety pattern for asynchronous or billable AI operations:
1. **Reserve**: Upfront credit hold before job queueing (`reserveCredits` -> returns `holdId`).
2. **Dispatch**: Enqueue job payload; on enqueue failure, immediately release hold.
3. **Capture / Release**: Worker finalizes hold upon completion (`captureHold`) or refunds upon failure (`releaseHold`).

### Workflow Run
A persisted DAG execution instance tracked in `runs` and `node_runs` tables orchestrating AI generation steps.

### Element
A reusable visual reference entity (clothing, character outfit, prop, background) containing reference images, consistency rules, and descriptive metadata.

### Character
A persistent AI influencer persona entity with canonical traits and multi-view reference sheets.
