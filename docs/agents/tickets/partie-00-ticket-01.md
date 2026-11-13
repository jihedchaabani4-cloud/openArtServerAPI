# Partie 00 · Ticket 01 — Break `nodeExecutor.js` <-> `workflowRunner.js`

Spec: `docs/designs/partie-00-bootstrap.md` § Ticket 0.1. Blocks: Ticket 04.

## Files (3)
- `src/v2/runner/nodeBilling.js` (new)
- `src/v2/runner/workflowRunner.js`
- `src/v2/runner/nodeExecutor.js`

## Steps
1. Create `nodeBilling.js`; move the billing/gateway block verbatim (lines `PROVIDER_BACKED_NODE_TYPES` .. `rollbackNodeBilling`).
2. Add `beginRunBillingAccumulator(runId)` and `endRunBillingAccumulator(runId)`.
3. In `workflowRunner.js`: import from `./nodeBilling.js`, use begin/end instead of the map, read `eventRecorder` via `getGateways()`, re-export all moved names.
4. In `nodeExecutor.js`: change the import source to `./nodeBilling.js`.

## Done when
- `nodeExecutor.js` has no import of `workflowRunner.js`.
- `npm test` green, unchanged count.
