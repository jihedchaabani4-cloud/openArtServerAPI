# Partie 00 · Ticket 03 — Break `catalogPresentation.js` <-> `models/index.js`

Spec: `docs/designs/partie-00-bootstrap.md` § Ticket 0.3. Blocks: Ticket 04.

## Files (3)
- `src/models/catalogQueries.js` (new)
- `src/models/index.js`
- `src/models/catalogPresentation.js`

## Steps
1. Move `getCatalog` and `calculateCost` verbatim into `catalogQueries.js`.
2. `index.js` imports + re-exports them (public `#models` API unchanged).
3. `catalogPresentation.js` imports from `./catalogQueries.js`.

## Done when
- `catalogPresentation.js` does not import `./index.js`.
- `tests/unit/modelsContract.test.js` and `npm test` green.
