# Partie 00 · Ticket 02 — Break `ElementService.js` <-> `promptBuilderProService.js`

Spec: `docs/designs/partie-00-bootstrap.md` § Ticket 0.2. Blocks: Ticket 04.

## Files (3)
- `tests/unit/elementPromptPayloadTokens.test.js` (new, written first, must be red)
- `src/domain/element/promptBuilderProService.js`
- `src/domain/element/ElementService.js`

## Steps
1. Red: test `ElementService.buildPromptPayload` with a fake `db` resolving `@Hero` -> description `"brave"`, media URL `https://cdn.test/hero.png`.
2. Remove the `./elementService.js` import; export `extractElementTokens`; drop `projectId` from `buildMultiElementPayload`.
3. `ElementService.buildPromptPayload` resolves tokens through `this.getElementContextForPrompt` and passes plain element DTOs.

## Done when
- New test green; `npm test` green.
- `promptBuilderProService.js` has zero imports.
