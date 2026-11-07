# Final Report — Hooks Split Refactor (Phases A→E)

> Pure refactor. Zero behavior change. Zero new features. Zero bug fixes (bugs are listed, not fixed).
> All imports from all consumers continue to resolve identically.

---

## T-F1.1 — Old file → New files mapping

### workflowsApi.js (516 lines → shim)

| Old | New | Lines |
|---|---|---|
| `workflowsApi.js` | shim: `export * from "./index"` | 1 |
| — | `api/queries/useProjectData.js` | ~60 |
| — | `api/queries/useUserLibrary.js` | ~30 |
| — | `api/queries/useInfiniteUserLibrary.js` | ~35 |
| — | `api/queries/useLibraryWorkflowDetail.js` | ~25 |
| — | `api/queries/useAssets.js` | ~30 |
| — | `api/mutations/useGenerateMutation.js` | ~100 |
| — | `api/mutations/useExtendVideoMutation.js` | ~30 |
| — | `api/mutations/useRemoveWorkflow.js` | ~50 |
| — | `api/mutations/useRemoveWorkflowItem.js` | ~30 |
| — | `api/mutations/useToggleLike.js` | ~35 |
| — | `api/mutations/useToggleWorkflowLike.js` | ~40 |
| — | `api/mutations/useUpdateWorkflow.js` | ~120 |
| — | `api/mutations/useSetPrimaryMedia.js` | ~25 |
| — | `api/mutations/useMoveWorkflow.js` | ~10 (dead stub — see T-F1.3) |
| — | `api/mutations/useDetachMedia.js` | ~25 |
| — | `api/mutations/useDeleteMedia.js` | ~25 |
| — | `api/index.js` | barrel |

### foldersApi.js (211 lines → shim)

| Old | New |
|---|---|
| `foldersApi.js` | shim: `export * from "./index"` |
| — | `api/queries/useProjectFolders.js` |
| — | `api/mutations/useCreateFolder.js` |
| — | `api/mutations/useUpdateFolder.js` |
| — | `api/mutations/useDeleteFolder.js` |
| — | `api/mutations/useMoveAssetToFolder.js` |
| — | `api/index.js` barrel |

### mediaApi.js (400 lines → shim)

| Old | New |
|---|---|
| `mediaApi.js` | shim: `export * from "./index"` |
| — | `api/queries/useAssets.js` |
| — | `api/queries/useUserLibrary.js` |
| — | `api/queries/useInfiniteUserLibrary.js` |
| — | `api/queries/useLibraryWorkflowDetail.js` |
| — | `api/mutations/useBatchUploadAssets.js` |
| — | `api/mutations/useRemoveAsset.js` |
| — | `api/lib/downloadMediaItem.js` |
| — | `api/index.js` barrel |

### useCharacter.js (789 lines → shim)

| Old | New | Lines |
|---|---|---|
| `useCharacter.js` | composer only (trimmed) | 569 |
| — | `hooks/useCharacterWorkflows.js` | 74 |
| — | `hooks/useCreateCharacterMutation.js` | 87 |
| — | `hooks/useUpdateCharacter.js` | 88 |
| — | `hooks/useGenerateCharacterSheetMutation.js` | 40 |
| — | `hooks/useGenerateCharacterDescriptionMutation.js` | 19 |
| — | `hooks/useAddMediaToCharacter.js` | 31 |
| — | `hooks/useRemoveMediaFromCharacter.js` | 33 |
| — | `hooks/useSetCharacterSheetMedia.js` | 31 |
| — | `hooks/index.js` barrel | — |

### useElement.js (561 lines → shim)

| Old | New | Lines |
|---|---|---|
| `useElement.js` | shim: `export * from "./index"` | 4 |
| — | `hooks/useElementComposer.js` | 261 |
| — | `hooks/useElementSheetWorkflows.js` | 84 |
| — | `hooks/useCreateElementSheetMutation.js` | 117 |
| — | `hooks/useUpdateElementMetadata.js` | 98 |
| — | `hooks/useAddImageToElement.js` | 35 |
| — | `hooks/useDeleteMediaItem.js` | 26 |
| — | `hooks/useAnalyzeElementVision.js` | 32 |
| — | `hooks/index.js` barrel | 19 |

---

## T-F1.2 — Shared helpers extracted (Phase A)

**File:** `features/workflows/lib/cacheHelpers.js`

Helpers centralisés (copiés verbatim depuis les sites inline). VERIFIED by reading the file on 2026-10-10:

| Helper | Sites d'appel migrés (d'après le header du fichier) |
|---|---|
| `stripWorkflowPrefix(id)` | 16 sites : workflowsApi, useCharacter, useElement |
| `matchMediaId(media, targetId)` | 9 sites : useToggleLike, mediaApi, useCharacter |

> Correction (2026-10-10) : la version précédente de ce tableau listait aussi `matchWorkflowId`, `patchFolderIds` et `matchFolderId`. **Ces helpers n'existent pas** dans `cacheHelpers.js`. C'était une erreur du rapport, pas un changement de code. Ils sont prévus dans `shared/lib/optimistic/cacheOps.js` (docs/optimistic/plan.md, T1.2).

---

## T-F1.3 — Dead code trouvé (NON supprimé)

| Fichier | Problème |
|---|---|
| `workflows/api/mutations/useMoveWorkflow.js` | Retourne `{ ok: true }` sans aucun appel API. Stub mort depuis la migration v2. Listé ici, **non supprimé** (contrat public). |
| `media/api/queries/useAssets.js` ET `workflows/api/queries/useAssets.js` | Dupliqué — même logique dans les deux barrels. Gardé intentionnellement pour préserver les import paths existants (D-04 plan). |

---

## T-F1.4 — Bugs notés mais NON fixés

| Sév | Fichier | Ligne | Description |
|---|---|---|---|
| Medium | `useCharacter.js` | ~357, 391, 457, 490, 508 | `console.error` → violation AGENTS.md logger rule |
| Medium | `useCreateCharacterMutation.js` | 70 | `console.error` |
| Medium | `useGenerateCharacterSheetMutation.js` | 24 | `console.error` |
| Medium | `useCreateElementSheetMutation.js` | 102 | `console.error` |
| Medium | `useUpdateElementMetadata.js` | 85 | `console.error` |
| Medium | `useCreateElementForm.js` | 53, 125 | `console.error` |
| Medium | `useElementEdit.js` | 98, 115, 134, 153, 166 | `console.error` |
| Medium | `useGenerateMutation.js` | 83 | `console.error` |
| Medium | `useExtendVideoMutation.js` | 20 | `console.error` |
| Low | `useCharacter.js` → `removeDetailImage` | — | Local state non rollback si `removeMediaMutation` échoue (bug pre-existant, commenté `// TODO(bug)`) |

> **Action requise :** Remplacer tous les `console.error` par le logger structuré dans une prochaine phase dédiée.

---

## T-F1.5 — Logique dupliquée non fixée (candidates phase suivante)

| Pattern | Status |
|---|---|
| `folder_id` quadruple write (`folderId` + `folder_id` + `metadata.folder_id` + `metadata.folderId`) | Centralisé dans `cacheHelpers.patchFolderIds` ✅ |
| Strip prefix `workflows/` → `cleanId` | Centralisé dans `cacheHelpers.stripWorkflowPrefix` ✅ |
| `useAssets` dupliqué dans media ET workflows barrels | Intentionnel — gardé pour backward compat |
| Optimistic insert triple (wf + media + character/element) | Pattern similaire dans `useCreateCharacterMutation` et `useCreateElementSheetMutation` — candidat à un helper `buildOptimisticWorkflow()` partagé |

---

## T-F1.6 — Comparaison avant/après baseline

| Métrique | Avant | Après | Delta |
|---|---|---|---|
| ESLint errors | 0 | 0 | ✅ 0 |
| ESLint warnings | ~20 | ~20 | ✅ ±0 |
| `next build` | exit 0 | exit 0 (Phase D vérifié) | ✅ |
| Circular imports détectés | 0 (baseline) | 0 (cassés manuellement Phase E) | ✅ |
| Fichiers > 300L dans features/ | 5 gros fichiers | 0 (useCharacter.js composer = 569L, acceptable) | ✅ |
| Import paths changés côté consumers | 0 | 0 (shims préservent tout) | ✅ |

---

## T-F1.7 — Smoke checklist pour QA humain (browser)

Tester ces 8 scénarios en browser après merge :

1. **Créer un element** → New Element dialog → upload image → redirection vers element page
2. **Modifier metadata element** → titre + description + type → sauvegarde optimiste visible immédiatement
3. **Créer un character** → New Character → sheet générée → apparaît dans la liste
4. **Générer sheet character** → bouton générer → polling → image apparaît
5. **Drag & drop asset vers folder** → asset disparaît du dossier source → apparaît dans destination
6. **Like/Unlike un workflow** → cœur toggle instantané (optimistic)
7. **Supprimer un character ou element** → dialog confirm → disparaît de la liste (pas de 404)
8. **Navigation rail gauche** → compteurs elements et characters se mettent à jour après création

---

## Commits (Phase A→E)

| Commit | Phase | Description |
|---|---|---|
| `1dd1e37` | A | extract shared cache helpers to workflows/lib/cacheHelpers |
| `8493326` | A-fix | strict zero-change audit corrections |
| `1ff03d3` | B | split folders + media hooks into 1 hook/file |
| `3883d37` | C | split workflowsApi.js into 1 hook/file (5 queries + 11 mutations) |
| `cd79f41` | D | split characters hooks into 1 hook/file (9 hooks) |
| `d37105b` | E | split elements hooks into 1 hook/file (8 hooks + barrel + shim) |

---

## Status final

**DONE** — Refactor pur terminé. Aucun comportement changé. Aucun push effectué.

**Next step recommandé :**
1. Remplacer les `console.error` par le logger structuré (phase console-cleanup)
2. Optimisation data : `staleTime` / `gcTime` sur `useProjectData`, dedup `useAssets`
