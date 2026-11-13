# Partie 00 · Ticket 04 — Systems guardrails + cycle rule in `arch-check`

Spec: `docs/designs/partie-00-bootstrap.md` § Ticket 0.4. Blocked by: Tickets 01–03.

## Files (4)
- `tests/unit/archSystemsRules.test.js` (new, written first)
- `tests/unit/archRuleR10.test.js` (gateway = `public/api.js` / `public/tools.js` only)
- `scripts/arch-check.cjs`
- `arch-baseline.json` (only via `--seed-rule R14`)

## Steps
1. Red: tests for R10 (tightened), R11, R12, R13, R14 (`findImportCycles`), R15 (`checkPackageImports`), repo regression for the 3 pairs.
2. Implement rules + `--seed-rule`.
3. `node scripts/arch-check.cjs --seed-rule R14`, review the listed files, commit.

## Done when
- `npm run arch` OK, `npm test` green.
- R14 baseline contains none of the Partie 0 files that were un-cycled.
