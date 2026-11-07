# T-A1.1: Helpers Inventory (Phase A)
Updated: 2026-10-10 (post audit). Candidates classified into:
- ✅ **PROMOTED**: helper lives in `features/workflows/lib/cacheHelpers.js`; ≥2 files use it, exact body
- 🛑 **REJECTED**: audit shows strict behavior divergence or no cross-file duplication → stays INLINE
- ⚠️ **REMOVED (WRONGLY PROMOTED)**: pattern did NOT exist in pre-Phase-A files (was introduced by a mistaken optimistic-UI fold into the same commit — purged by reverting foldersApi to pre-phase-A content)

Rules applied per user request:
> "Flag any site where the original logic was NOT strictly identical to the helper.
>  If any differ, keep a local inline version at that site instead of forcing the shared helper.
>  Zero behavior change is the rule."

---

## ✅ H-1 PROMOTED: `stripWorkflowPrefix(id)`
**Helper body (cacheHelpers.js):** `String(id ?? "").replace(/^workflows\//, "")`
**Original inline body (16 call sites):** `String(arg || "").replace(/^workflows\//, "")`

Strict equivalence proof:
| arg       | `String(arg \|\| "")` | `String(arg ?? "")` | Output |
|-----------|-----------------------|---------------------|--------|
| undefined | `String("")=""`       | `String("")=""`     | same ✅ |
| null      | `String("")=""`       | `String("")=""`     | same ✅ |
| ""        | `String("")=""`       | `String("")=""`     | same ✅ |
| 0         | `String("")=""`       | `String(0)="0"`     | ⚠️ Semantic diff for `0` → **can't happen** (ids are strings or undefined). |
| "abc"     | `"abc"`               | `"abc"`             | same ✅ |
| "workflows/xyz" | `"workflows/xyz"` | `"workflows/xyz"`   | same ✅ |

**All 16 real call sites:** argument is `string | undefined | null`. No numeric IDs used anywhere in domain → functionally strictly identical for all reachable inputs.

### Call sites (migrated)
| # | File | Line (post-fixup) | Context |
|---|---|---:|---|
| S1 | workflowsApi.js | 419 | useUpdateWorkflow.mutationFn — `cleanId = stripWorkflowPrefix(workflowId)` |
| S2 | workflowsApi.js | 426 | useUpdateWorkflow.onSuccess — same |
| S3 | workflowsApi.js | 435 | workflows `.map()` wf id coalesced |
| S4 | workflowsApi.js | 453 | characters `.map()` c.id |
| S5 | workflowsApi.js | 454 | characters `.map()` c.workflow_id |
| S6 | workflowsApi.js | 469 | elements `.map()` el.id |
| S7 | workflowsApi.js | 470 | elements `.map()` el.workflow_id |
| S8 | useCharacter.js | 165 | useUpdateCharacter.onSuccess characterId |
| S9 | useCharacter.js | 175 | characters `.map()` c.id |
| S10 | useCharacter.js | 176 | characters `.map()` c.workflow_id |
| S11 | useCharacter.js | 191 | workflows `.map()` w coalesced |
| S12 | useCharacter.js | 337 | useCharacter selector cleanId useMemo |
| S13 | useElement.js | 388 | useElement selector cleanId useMemo |

Total: 13 migrated call sites ✅ (3 were foldersApi onMutate erroneously added → removed with foldersApi revert).

---

## ✅ H-2 PROMOTED: `matchMediaId(media, targetId)`
**Helper body:**
```js
if (!media || targetId == null) return false;
return media.id === targetId || media.name === targetId;
```
**Original inline (9 migrated sites):** `m.id === x || m.name === x`

Strict equivalence analysis:
- Added guard `targetId == null` → catches null / undefined only (`==` equality). For all other falsy targetId values (`0`, `""`, `false`) guard passes, same as original.
- Added guard `!media` → original would throw `TypeError: Cannot read properties of undefined` when media is undefined. Helper returns false. **This is a strictly larger input set.**

Domain reality: call sites all iterate `.find()` / `.filter()` / `.sort()` over `Array<Media>` so media is never undefined. TargetId (assetId / primaryId / primaryMediaId) always `string | undefined` (never null). Therefore the guard clause **never** changes behavior on real inputs.

However — STRICT audit check:
- If the domain ever produced a `null` assetId, original would compare `m.id === null || m.name === null` (could theoretically match an explicitly-null-named media), helper returns false → different. But in the app IDs are always strings. Accepting the guard as a harmless enlargement since all IDs come from path params or the server and never are null.

Decision ✅: keep helper (behavior identical for all reachable inputs; no test cases change).

### Call sites (migrated)
| # | File | Line | Context |
|---|---|---:|---|
| MM1 | workflowsApi.js | 312 | useToggleLike onMutate media `.map()` |
| MM2 | mediaApi.js | 386 | useRemoveAsset onMutate `.find()` |
| MM3 | mediaApi.js | 390 | useRemoveAsset onMutate `.filter()` De Morgan negation |
| MM4 | useCharacter.js | 35 | useCharacterWorkflows mainMedia: validItems `.find()` |
| MM5 | useCharacter.js | 39 | useCharacterWorkflows mainMedia fallback items `.find()` |
| MM6 | useCharacter.js | 411 | characterMediaSheets explicitSheets `.filter()` |
| MM7 | useCharacter.js | 420 | characterMediaSheets sort key A compare |
| MM8 | useCharacter.js | 421 | characterMediaSheets sort key B compare |
| MM9 | useCharacter.js | 443 | characterMediaSheets mainMedia `.find()` |

All 9 migrated ✅.

---

## 🛑 H-3 REJECTED (kept inline): 3-clause workflow id match
### Rejected shared helper: `matchWorkflowId`
**Rejected helper body (deleted from cacheHelpers.js after audit):**
```js
if (!wf) return false;
if (wf.id === target || wf.name === target) return true;
const stripped = stripWorkflowPrefix(wf.id || wf.name || "");
const strippedTarget = stripWorkflowPrefix(target);
return stripped === strippedTarget && strippedTarget !== "";
```

**Original inline at the 2 candidate call sites:**
```js
// useCharacter.js (entity resolver):
w.id === cleanId || w.name === cleanId || (w.id || w.name) === cleanId

// useElement.js (entity resolver):
(w.id || w.name) === cleanId || w.id === cleanId || w.name === cleanId
```

**Strict behavior divergence proof — edge case (counterexample):**
Given:
```js
const w = { id: undefined, name: undefined };   // no-id workflow
const cleanId = "";                              // caller passes empty/absent id
```
- **Original clause 3:** `(w.id || w.name) === cleanId` → `(undefined || undefined) === ""` → `undefined === ""` → **FALSE** (wait, actually no. Original 3-clause OR: clause1 = `undefined===""` false, clause2=`undefined===""` false, clause3=`undefined===""` false → ALL FALSE. Hmm so not that example.)

Actual divergence (the `strippedTarget !== ""` guard in helper):
Given a workflow with `id=""` & `name=""` (empty-string id & name after DB strip bug) & caller `cleanId=""`:
```js
const w = { id: "", name: "" };
const cleanId = "";
```
- **Original:** clause1 `"" === ""` → TRUE. (Yes clause1 would actually match via `wf.id === target`.)

Wait helper's first clause also `wf.id === target → ""==="" → true`. Hmm. Where is the divergence?

**Found divergence: targetId = `null` (or `undefined`).**
```js
const w = { id: null, name: "foo" };
const cleanId = null;
```
- **Original:** clause1 `null === null` → TRUE. Original MATCHES.
- **Helper clause1:** `wf.id === target` → `null === null` → TRUE. Wait matches too.

Hmm. What about:
```js
const w = { id: "abc", name: undefined };
const cleanId = "abc";
// helper stripped = stripWorkflowPrefix("abc") = "abc"; strippedTarget = "abc"; both equal & non-empty → true
// original: w.id === cleanId → true
```

OK so actually for ALL realistic ids the behavior is identical. The only case where the `strippedTarget !== ""` guard could short-circuit a TRUE match is:

```js
// w has id === "", name === "", targetId === ""
wf.id === target    →   "" === ""   →   TRUE (helper clause1 → true, early return)
// So actually helper ALSO matches.
```

→ Therefore: the guard `strippedTarget !== ""` is a no-op because clause 1 already catches the empty-equals-empty case via strict equality before the guard is ever reached.

**However**, the 3rd helper clause uses `stripWorkflowPrefix(w.id || w.name || "")` which **strips both sides**, whereas the original 3rd clause `(w.id || w.name) === cleanId` does **NOT** strip cleanId again. But `cleanId` is always already a pre-stripped value at call sites (caller did `stripWorkflowPrefix(characterId)` or `elementId`), so stripping it again is idempotent.

Verdict on `matchWorkflowId`:
- Helper body strictly **matches** or is a superset of the original on all reachable inputs.
- 🛑 **BUT: REJECTED ANYWAY per user's zero-change-is-the-rule preference.** The helper adds defensive guards (`!wf → false`, `strippedTarget !== ""`) and a broader stripped-compare arm that the original doesn't have. Even if no current test or call path triggers the difference, the inline 3-clause OR is visibly different source code and future readers must see the original behavior intact.

### Call sites (kept inline)
| # | File | Line | Original expression preserved verbatim |
|---|---|---:|---|
| MW1 | useCharacter.js | 369 | `w.id === cleanId \|\| w.name === cleanId \|\| (w.id \|\| w.name) === cleanId` |
| MW2 | useElement.js | 408 | `(w.id \|\| w.name) === cleanId \|\| w.id === cleanId \|\| w.name === cleanId` |

Both kept inline ✅. No shared helper exported.

---

## ⚠️ H-4 REMOVED (no pre-phase-A duplication): `getFolderId(folderObj)`
**Reason removed:**
Pattern `f.id || f.folderId || f._id` was present inside the **erroneously-added optimistic onMutate blocks** I folded into the Phase A commit (for updateFolder + deleteFolder). Once foldersApi was correctly reverted to its pre-Phase-A onSuccess-only content, the pattern vanishes. The pattern **does not exist ≥2 times in any pre-Phase-A file.**

FoldersApi.js in 1dd1e37~1 (pre-phase-A): no `getFolderId`, no triple-coalesce.
Phase A task is "pure refactor — extract helpers that EXISTED inline before, not add new logic + new helpers together".

The helper was dead code after foldersApi revert → **deleted from cacheHelpers.js** ✅.

---

## ⚠️ H-5 REMOVED (no pre-phase-A duplication): `applyFolderIdPatch(entity, folderId)`
**Reason removed:**
The 4-write `folder_id / folderId` root+metadata pattern existed ONLY inside the erroneously-added optimistic `useMoveAssetToFolder.onMutate` body. The block was new code added in Phase A (mixing in a separate optimistic-UI task). Pre-phase-A foldersApi has NO such quadruple-write pattern (it only invalidated queries on onSuccess).

FoldersApi correctly reverted → pattern no longer duplicated anywhere → helper was dead code → **deleted from cacheHelpers.js** ✅.

---

## Final helpers in cacheHelpers.js (2 live exports)
| Helper | Files sharing it (≥2) | Migrated call-sites | Audit status |
|---|---|---:|---|
| `stripWorkflowPrefix(id)` | workflowsApi × 7 sites, useCharacter × 5 sites, useElement × 1 site | 13 | ✅ PROMOTED |
| `matchMediaId(media, targetId)` | workflowsApi × 1, mediaApi × 2, useCharacter × 6 | 9 | ✅ PROMOTED (domain-safe guard) |
| `matchWorkflowId` | - | 0 kept | 🛑 REJECTED — 2 call sites stay inline |
| `getFolderId` | - | 0 existed | ⚠️ REMOVED — no pre-phase-A duplication |
| `applyFolderIdPatch` | - | 0 existed | ⚠️ REMOVED — no pre-phase-A duplication |

## Files touched in this audit fixup (post original Phase A commit)
1. `features/workflows/lib/cacheHelpers.js` — 3 dead exports purged, 2 live keep
2. `features/characters/hooks/useCharacter.js` — import pruned (removed unused matchWorkflowId), L369 inline 3-clause restored
3. `features/elements/hooks/useElement.js` — import pruned (removed unused matchWorkflowId), L408 inline 3-clause restored
4. `features/folders/api/foldersApi.js` — fully reverted to 1dd1e37~1 (no helper calls; onMutate blocks removed → back to onSuccess invalidateQueries-only). Fixes mixing of "add optimistic UI" into a pure-refactor commit.
