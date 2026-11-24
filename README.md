# OpenArt Backend Monolith (`apiOpenArt`)

Strict Zero-Duplication Modular Monolith for the OpenArt AI media generation platform.

## Canonical Documentation

Start with these unified reference documents before modifying any code:
- [`AGENTS.md`](AGENTS.md) / [`CLAUDE.md`](CLAUDE.md) — Mandatory agent workflow, iron laws, and command gate.
- [`docs/architecture/SYSTEMS_ARCHITECTURE.md`](docs/architecture/SYSTEMS_ARCHITECTURE.md) — The 8 Business Systems (`auth`, `billing`, `storage`, `generation`, `models`, `elements`, `characters`, `project`), their 3-layer anatomy, and canonical service ownership.
- [`docs/architecture/ARCHITECTURE_RULES.md`](docs/architecture/ARCHITECTURE_RULES.md) — Strict mechanical rules `R1` to `R17` enforced by `scripts/arch-check.cjs`.
- [`docs/agents/GLOSSARY.md`](docs/agents/GLOSSARY.md) — Domain glossary and bounded context terminology.
- [`docs/agents/service-catalog.md`](docs/agents/service-catalog.md) — Auto-generated catalog of all services and system public surfaces (`npm run catalog`).

## Worker Processes

The system runs two separate queue workers:
- **AI Generation Worker**: `npm run start:worker` (or `npm run dev:worker` in development). Entry point: `worker.js` (bootstraps `src/container.js` then starts `src/systems/generation/internal/workers/worker.js`).
- **Wallet Maintenance Worker**: `npm run start:wallet-worker` (or `npm run dev:wallet-worker` in development). Entry point: `src/systems/billing/internal/workers/walletWorker.js`.

## Environment Variables

Ensure these are set in your `.env`:
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
- `REDIS_URL`

## Quality & Architecture Gate

Run the full verification gate before finishing any task:

```bash
npm run gate
```

This runs:
1. `node scripts/arch-check.cjs` (`npm run arch`) — Enforces all 17 architectural rules (`R1`–`R17`) with 0 violations.
2. `node scripts/build-service-catalog.cjs --check` (`npm run catalog:check`) — Ensures `docs/agents/service-catalog.md` is up to date.
3. `node scripts/check-doc-paths.cjs` — Verifies that every file path referenced in the documentation exists on disk.
4. `node scripts/secrets-scan.cjs` — Scans for accidentally committed secrets.
5. `npm test` — Runs the full Jest test suite.
