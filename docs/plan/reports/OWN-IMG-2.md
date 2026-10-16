# OWN-IMG-2: Normalize Media Parameters at Boundary & Enforce Ownership Across All Shapes
Status: DONE
Commit: (recorded in STATE.md)
Self-review score: 98/100 (loops: 1)
Baseline `npm test` before: PASS (698/698 pass across 152 suites)   After: PASS (704/704 pass across 152 suites — +6 passing tests, 0 failures)

## What changed (REUSED / EXTENDED / CREATED)

- EXTENDED `src/platform/security/ownership.js`
  — Added exported shared helper `toMediaIdList(value)` (Decision `D-26`): normalizes any string, object (`{ workflow_id, workflowId, id, media_id, mediaId, url }`), or array of strings/objects into a flat array of non-empty trimmed strings, returning `[]` for anything else.
- EXTENDED `controllers/imageController.js`
  — Used `toMediaIdList(references)` for top-level `references` sanitization.
  — Used `toMediaIdList(parameters[field])` across all media parameter keys (`input_image`, `image_url`, `mask`, `last_frame`, `input_video`, `images`, `reference_images`, `reference_videos`) to enforce `assertOwnsAny(["workflow", "media"], mediaRefId, userId)` before workflow/media/billing creation.
  — Normalized array-typed media parameters (`images`, `reference_images`, `reference_videos`) on `resolvedParams` using `toMediaIdList`.
- EXTENDED `controllers/videoController.js`
  — Used `toMediaIdList(references)` for top-level `references` sanitization.
  — Used `toMediaIdList(parameters[field])` across all media parameter keys (`input_image`, `image_url`, `mask`, `last_frame`, `input_video`, `images`, `reference_images`, `reference_videos`) to enforce `assertOwnsAny(["workflow", "media"], mediaRefId, userId)` before workflow/media/billing creation.
  — Normalized array-typed media parameters (`images`, `reference_images`, `reference_videos`) on `resolvedParams` using `toMediaIdList`.
- EXTENDED `src/v2/nodes/imageGenerationNode.js` & `src/v2/nodes/videoGenerationNode.js`
  — Used `toMediaIdList(resolvedParams.images)` during node media URL resolution so string, object, and array shapes resolve identically.
- EXTENDED `tests/boundary/referenceAndMediaOwnershipBoundary.test.js`
  — Added `TESTS 8–13` covering cross-tenant string, array, and object shapes for `images`, `reference_images`, `reference_videos`, `input_image`, `last_frame`, `input_video`, top-level `references`, legitimate owner string/array normalization, and `toMediaIdList` unit checks.
- EXTENDED `docs/plan/DECISIONS.md` (`D-26`), `docs/plan/BACKLOG.md`, `docs/plan/STATE.md`.

---

## Sweep Results (`Array\.isArray\(.*(images|reference|input_)`)

**VERIFIED** via PowerShell scan across `src/`, `controllers/`, `routes/` (26 total matches):

| Site (`file:line`) | Role | Disposition |
|---|---|---|
| `controllers/imageController.js:70` | Top-level `references` sanitization | **FIXED** (uses `toMediaIdList(references)`) |
| `controllers/imageController.js:115` | `parameters.images` ownership check | **FIXED** (uses `toMediaIdList(parameters[field])` across all 8 media keys) |
| `controllers/videoController.js:69` | Top-level `references` sanitization | **FIXED** (uses `toMediaIdList(references)`) |
| `controllers/videoController.js:117` | `parameters.images` ownership check | **FIXED** (uses `toMediaIdList(parameters[field])` across all 8 media keys) |
| `src/v2/nodes/imageGenerationNode.js:66` | Node `resolvedParams.images` resolution | **FIXED** (uses `toMediaIdList(resolvedParams.images)`) |
| `src/v2/nodes/videoGenerationNode.js:101` | Node `resolvedParams.images` resolution | **FIXED** (uses `toMediaIdList(resolvedParams.images)`) |
| `src/domain/character/CharacterService.js:441` & `src/domain/character/CharacterGenerationService.js:108` | Character sheet `references` forwarding | Logged in `BACKLOG.md` (`[Medium]`) |
| `src/v2/nodes/safety/NodeSafetyService.js:109,153` | V2 LLM / PromptBuilder node input sanitizer | Logged in `BACKLOG.md` (`[Low]`) |
| `src/v2/nodes/promptBuilderNode.js:72,73,202,203,210,327` | Internal resolved entity image tagging in PromptBuilder | Out of scope (operates on already-resolved DB entities / `safe.references`) |
| `src/v2/nodes/llmNode.js:118` | LLM output JSON parser (`parsed.references`) | Out of scope (model output, not client input) |
| `src/domain/element/ElementService.js:45,185` & `src/domain/element/ElementMediaService.js:55,220,297` | Element `sourceImages` validation & DB `source_images` reads | Out of scope (Element creation already enforces `Array.isArray(sourceImages)` with 400) |
| `src/models/mapping/parameterMapper.js:141`, `src/v2/nodes/imageGenerationNode.js:91,92`, `src/v2/runner/nodeExecutor.js:91` | Provider output response normalization (`output.images` / `runResult.images`) | Out of scope (provider output, not client input) |

---

## Evidence

- **VERIFIED**: `node --test tests/boundary/referenceAndMediaOwnershipBoundary.test.js` -> `13 tests, 13 pass, 0 fail`.
- **VERIFIED**: `npm test` -> `704 tests, 152 suites, 704 pass, 0 fail`.
- **VERIFIED**: `git diff --cached | Select-String -Pattern "(secret|token|apikey|password|bearer\s+[a-zA-Z0-9_\-\.]{20,})"` -> empty output.
- **VERIFIED**: No `console.*` added in any modified file (`Select-String -Path src/platform/security/ownership.js,controllers/imageController.js,controllers/videoController.js,src/v2/nodes/imageGenerationNode.js,src/v2/nodes/videoGenerationNode.js -Pattern "console\."` -> 0 hits).

## Self-review findings

- PASS — Security: every media parameter key and shape (`string`, `array`, `{ workflow_id, id }`) is checked with `assertOwnsAny` before workflow/media/hold creation, returning `404` on cross-tenant access
- PASS — Correctness: `toMediaIdList` is shared between controllers and V2 nodes; `schemaValidator.js` left unchanged per instructions
- PASS — Operability: structured logger only, zero `console.*`
- PASS — Tests: 6 new boundary + unit tests (`TESTS 8–13`) failed first (`5 fail`) and now pass (`13/13`); full suite `704/704` pass
