---
status: accepted
---

# Explicit-intent bulk delete endpoints with configurable bounded concurrency

Single-item deletion in `TrashService.js` (`TrashService.requestDelete`) uses an implicit two-call toggle: the first call moves an active Workflow into `public.trash`, and a second call on an already-trashed Workflow permanently deletes it. Extending that implicit toggle to multi-select bulk deletion is unsafe—a stale browser tab, double-click, or mixed workspace selection containing an already-trashed item would silently trigger irreversible destruction.

We decided to split bulk deletion into two explicit-intent endpoints:

1. **Workspace Move-to-Trash (`POST /api/workspace/bulk-delete`):** Accepts typed ID arrays (`folder_ids`, `workflow_ids`, `character_ids`, `element_ids`) capped at **100 total input IDs** per request. Before mutating state, it deduplicates overlapping folder subtrees and contained/attached items and validates ownership **all-or-nothing**. It then idempotently inserts active workflows into `public.trash` (preserving any already-trashed items without permanently deleting them), clears `folder_id = null` on workflows in deleted folders, permanently removes selected folder subtrees deepest-first (consistent with `docs/adr/0001-folder-deletion-trashes-workflows.md`), and directly deletes orphan Characters/Elements (`workflow_id = null`) that have no container Workflow.
2. **Trash Permanent Bulk Delete & Empty Trash (`POST /api/trash/delete`):** Performs explicit permanent destruction exclusively on items already in Trash, accepting either selected trashed `workflow_ids` (max 100, rejecting active non-trashed items) or `{ all: true, project_id? }` to empty Trash. Permanent cleanup (workflows, orphan media via `unlink_workflow_media_and_reap_orphan`, storage object deletion, and sidecar character/element rows) executes with configurable bounded concurrency via `BULK_DELETE_CONCURRENCY` (`src/shared/config/env.js`).

Both endpoints are protected by a dedicated per-user `bulkDelete` rate-limit policy (**30 requests / 60 seconds / user**, `failPolicy: "open"`, defined in `src/shared/config/rateLimitPolicies.js`). Legacy `DELETE /api/workflows/workflows` and single-item `TrashService.requestDelete` remain intact for backward compatibility.

## Considered Options

1. **Implicit toggle in a single mixed bulk endpoint:** Rejected. Mixing active and already-trashed items—or retrying from a stale tab—would silently escalate a soft-delete intent into irreversible data loss.
2. **Unbounded `Promise.all` / `Promise.allSettled` for permanent deletes:** Rejected. Firing up to 100 concurrent DB/Storage cleanup chains in parallel risks saturating Supabase Postgres connections and Storage API throughput, degrading concurrent workflow generation and normal API traffic.
3. **Hardcoded concurrency = 5 without benchmark evidence:** Rejected. Baking an unmeasured static constant into code prevents operators from tuning throughput or safety margins as infrastructure capacity changes.
4. **Explicit intent endpoints + configurable bounded concurrency (chosen):** Separates soft-delete from permanent destruction at the HTTP contract boundary and bounds permanent-delete parallelism via `BULK_DELETE_CONCURRENCY` (default `10`, validated and clamped to `[1, 15]` — minimum `1`, maximum `15`, never unbounded `Promise.all()`).

## Operational Defaults & Concurrency Benchmark / Verification Plan

> **Important:** `BULK_DELETE_CONCURRENCY` (default `10`, clamped to `[1, 15]`) and the `bulkDelete` rate limit (`30 req / 60s / user`, fail-open) are **initial operational defaults, not benchmark-proven optimal values**. They are conservative guardrails chosen to protect concurrent workflow generation, normal API requests, and Supabase DB/Storage operations until measured under realistic load.

Before changing defaults in production, run a controlled benchmark in staging (mirroring production Postgres pool size and Supabase Storage tier) comparing `BULK_DELETE_CONCURRENCY` values of **5**, **10**, and **15** under steady background API + workflow-generation traffic:

| Dimension | Metrics to Capture (at concurrency = 5, 10, 15) |
| --- | --- |
| **Deletion throughput** | Workflows deleted/sec and total wall-clock duration for 50-item and 100-item permanent-delete / Empty Trash batches. |
| **API latency** | p50, p95, and p99 latency of concurrent normal read/write endpoints and workflow generation dispatch during bulk-delete bursts. |
| **Database pressure** | Active Postgres connections, `unlink_workflow_media_and_reap_orphan` lock/query latency, and DB timeout/error rates. |
| **Storage latency** | Supabase Storage object-delete p95 latency and `storage_failures` rate per batch. |

**Rollout & Tuning Criteria (within `[1, 15]`):**
- **Lower toward `5`** if concurrent API p95 degrades by >15–20%, Postgres connection utilization nears pool exhaustion, `unlink_workflow_media_and_reap_orphan` lock waits or timeouts increase, or `storage_failures` spike.
- **Keep at `10`** if 50–100 item batches complete comfortably within HTTP/UX latency budgets with flat background API p95 and near-zero DB/Storage errors.
- **Raise toward `15`** only if 100-item batch wall time approaches UX or request-timeout limits **and** staging measurements at `15` confirm flat concurrent API p95, healthy DB connection headroom, and no elevated `storage_failures`.

## Consequences

- **No accidental permanent deletion:** Workspace bulk delete is strictly idempotent Move-to-Trash; already-trashed items in mixed selections or stale tabs stay safely in Trash.
- **Explicit destruction guard:** `POST /api/trash/delete` rejects non-trashed `workflow_ids`, ensuring callers cannot bypass Trash with a permanent-delete request.
- **Atomic upfront authorization & predictable payload shape:** Typed ID arrays (`folder_ids`, `workflow_ids`, `character_ids`, `element_ids`), overlap deduplication, all-or-nothing ownership verification, and the 100-item cap prevent partial unauthorized mutations and oversized single requests.
- **Consistent orphan handling:** Characters and Elements with `workflow_id = null` cannot enter `public.trash` (which is keyed on `Workflow`) and are deleted directly during bulk workspace delete, matching single-item semantics.
- **Backward compatibility preserved:** Legacy `DELETE /api/workflows/workflows` continues working untouched for existing clients.
- **Tunable, bounded blast radius:** Permanent deletion never runs unbounded `Promise.all()`, and operators can tune `BULK_DELETE_CONCURRENCY` within `[1, 15]` without code deploys once benchmark data is collected.
