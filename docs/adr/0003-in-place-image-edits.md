---
status: accepted
---

# In-place parent-workflow image edits with immediate primary swap and server-locked edit model

Adding specialized in-place image editing flows (`image-relight-v3` in `src/systems/workflow-engine/internal/workflows/imageRelightV3.js` and `image-angles-v3` in `src/systems/workflow-engine/internal/workflows/imageAnglesV3.js`) required clear ownership, version-history, and model-selection invariants across the HTTP boundary (`src/systems/generation/public/api.js`, `imageController.js`), request orchestration (`GenerationRequestService.js`), and V3 execution nodes (`resolveRefsNode.js`, `imageGenerateNode.js`).

We made three architectural decisions:

1. **In-place parent-workflow append keyed solely on `workflow_id`:** Edit requests target an existing parent Workflow via `workflow_id` rather than creating a standalone child Workflow or trusting a client-supplied `media_id`. The backend verifies ownership of `workflow_id`, resolves the Workflow's current primary media as `source_media_id` (and its URL as `source_image_url`), rejects any client-supplied `media_id`, and appends the newly generated output media to the same Workflow's history.
2. **Immediate `is_primary = true` swap upon edit placeholder creation:** When the edit placeholder media row is created in `processing` status, it is immediately linked to the parent Workflow with `is_primary = true` (updating `workflow.primary_media_id`). This gives the library card immediate visual feedback while the edit runs and naturally supports chained edits. If execution fails, the failed placeholder remains primary so the error state is directly visible on the card; users can revert to any earlier version at any time via `PATCH /api/workflows/:id/primary-media`.
3. **Server-locked fixed image-editing model (`nanobana_2`):** Both `image-relight-v3` and `image-angles-v3` statically bind `generate_image` to `model: "nanobana_2"` with `operation: "edit"`, and the HTTP contract rejects any client-supplied `model` field with `400`. `ImageGenerateNode.estimateCost` honors `operation: "edit"` at compile time so upfront credit holds charge the edit pricing tier (`src/systems/models/internal/manifests/nanobana_2/model.json`) rather than `text_to_image` pricing.

## Considered Options

1. **Spawn a new Workflow per edit (clone-on-edit):** Rejected. Clutters the user's project grid with disconnected cards for every relight or angle adjustment and breaks linear edit history on a single asset.
2. **Accept client-supplied `media_id` alongside `workflow_id`:** Rejected. Expands the authorization and consistency surface (mismatched `workflow_id`/`media_id` pairs, stale or unowned media references) when the parent Workflow already has an authoritative primary media pointer.
3. **Defer primary-media swap until worker completion (or auto-revert primary on failure):** Rejected. Hides in-progress spinners and failure reasons from the main Workflow card, forces custom client polling side-channels, and breaks sequential edit chaining.
4. **Allow caller-selectable image models for relight/angles:** Rejected. Structured lighting and virtual-camera prompt skills are calibrated specifically for `nanobana_2` edit execution; letting clients override `model` risks broken edits, silent fallback to non-edit models, or mismatched compile-time pricing.
5. **In-place append by `workflow_id` + immediate primary swap + server-locked `nanobana_2` (chosen):** Keeps all iterations grouped under one Workflow, surfaces live processing and failure states deterministically, preserves non-destructive version history reversible via `PATCH /api/workflows/:id/primary-media`, and guarantees edit-route pricing and prompt-skill fidelity.

## Consequences

- **Single source of truth for edit target:** Rejecting client `media_id` eliminates cross-workflow media spoofing; every edit deterministically derives `source_media_id` from the authenticated owner's Workflow primary media.
- **Explicit failure visibility & manual recovery:** Keeping a failed edit placeholder as `is_primary = true` ensures users see why an edit failed and can retry or switch back to the prior version via `PATCH /api/workflows/:id/primary-media` without losing earlier renders.
- **Accurate compile-time edit billing:** Static `model: "nanobana_2"` and `operation: "edit"` in `imageRelightV3.js` and `imageAnglesV3.js`, paired with `ImageGenerateNode.estimateCost` in `imageGenerateNode.js`, ensure upfront credit holds match runtime `edit` route pricing even before `resolveRefsNode.js` executes.
- **Clean model upgrades:** Upgrading the underlying edit model in the future is a single server-side workflow blueprint change with no client API contract break.
