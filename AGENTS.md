# apiOpenArt (backend)

Root rules apply (see ../AGENTS.md). This file adds backend specifics only.

## Commands
- `npm run gate` before every commit (arch-check, catalog, doc paths, secrets, full npm test). `npm run gate -- --fast` skips npm test while iterating.
- `npm run catalog` regenerates docs/agents/service-catalog.md. Commit it with the service change.
- `npm run arch` shows rule counts. `node scripts/arch-check.cjs --report` lists every violation.
- Real-Postgres SQL gate (manual, not CI): `node scripts/run-disposable-shared-media-test.js`.

## Layers (calls go down only)
route -> controller -> service -> repository -> DB. A service reaches another service only through a constructor-injected dependency.
Details: ../docs/agents/rules/services.md. Concern -> owner: ../docs/agents/maps/backend-map.md.

## Every new *Service.js
- Header comment with a line `@owns <one sentence>` and its public methods.
- Constructor throws if a dependency is missing. Register it in the container + a wiring test.
- Run `npm run catalog`.
