# Phase P-1 + P0: setup and task D2.6

> Read `00_CORE.md` completely BEFORE this file (rules, loop, rubric, decisions). Section numbers are those of the original plan; the index in `00_CORE.md` says where each section lives.
> Scope of THIS file: sections 3 (SETUP-1, SETUP-2) and 4 (D2.6). Do not read or start other phase files.
> Prerequisites: none (first phase). The repo has AGENTS.md; `npm test` runs.

## Order of work in this session

1. SETUP-1 (plan folders and state files).
2. SETUP-2 (Spec Kit install and init, or only a verification if it is already installed; see its Step 0). If `SPEC_KIT = OFF`: mark SETUP-2 as SKIPPED in STATE.md and log D-14 in DECISIONS.md.
3. If `SPEC_KIT = ON`: PREP-P0 (see the end of section 3 below), STOP, wait for `GO`.
4. Task D2.6 (sub-items a to e), one commit.
5. Phase gate, acceptance test, STOP.

---

## 3. Phase P-1: Setup (part of this session)

### SETUP-1: plan folders

Create these files (they live in `docs/plan/`):

- `STATE.md`: from template 2.5. List every task id of this plan with status `TODO`: SETUP-1, SETUP-2, D2.6, D3, SES0, GEN1, NAM0, DM1, F-T1 to F-T9 (section 7.8).
- `DECISIONS.md`: copy the table of section 12 as the first lines (D-01 to D-25).
- `BACKLOG.md`: header only.
- Folders `reports/` and `escalations/` (put an empty `.gitkeep` in each).
- Add `docs/plan/scratch/` to `.gitignore` (create the entry if missing).
- Check `AGENTS.md`: if it does NOT contain the `Project rules` block (`00_CORE.md` section 9.4), add that block ABOVE any Spec Kit markers (`<!-- SPECKIT ... -->`), or at the top if there are none. Do not edit or delete anything else in AGENTS.md, in particular not the line that points to `specs/<NNN>-.../plan.md` and not anything between Spec Kit markers. Show the result with `git diff AGENTS.md` in the report.

Commit: `phase-1(SETUP-1)`. No test needed (docs only), but still run `npm test` to confirm the baseline.

### SETUP-2: Spec Kit

What it is: Spec Kit is GitHub's toolkit for spec-driven development. It adds slash commands to your agent. The flow for a feature is: constitution (project rules) -> specify (what to build) -> clarify (remove ambiguity) -> plan (how) -> tasks (small steps) -> analyze (consistency check) -> implement (do it).

How we use it (details in `05_SPEC_KIT_GUIDE.md`): Spec Kit is the PLANNER and task splitter. This file stays the source of truth. One Spec Kit feature per phase (P0, P1, P3). It is prepared at the end of the previous phase, never far ahead. If Spec Kit and this file disagree, this file wins.

**Step 0 (always first): is Spec Kit already installed in this repo?**
Run: `ls -a | rg "^\.specify$"; ls specs 2>/dev/null; ls .gemini/commands .claude/commands 2>/dev/null`.
- If `.specify/` or `specs/` exists: Spec Kit is ALREADY installed (this repo already has Spec Kit features, for example `specs/033-prompt-bar-platform/`). Then:
  a. Do NOT run `specify init` (it could overwrite files).
  b. Run `specify check` if the CLI is available (not mandatory).
  c. List the command files of your agent and write the REAL command names in DECISIONS.md.
  d. Do NOT replace the existing constitution (`.specify/memory/constitution.md`). Our rules live in AGENTS.md and `00_CORE.md` and win for this plan. Log that in DECISIONS.md.
  e. Never touch the existing feature folders under `specs/` (for example `specs/033-...`). New features are numbered automatically after them (for example `034-...`).
  f. Skip steps 1 to 6 below; no init commit is needed. Mark SETUP-2 DONE with the note "already installed".
- If neither exists: Spec Kit is not installed; continue with steps 1 to 6.
- The line in AGENTS.md that points to `specs/<NNN>-.../plan.md` is Spec Kit's pointer to the plan of ANOTHER feature. Background context only. NOT your task. Never modify it.

Steps (only when Spec Kit is not installed yet):
1. Check the tools: `uv --version` (or `uvx --version`) and `git --version`. If `uv` is missing, try `pipx run` or `pip install uv`. If you cannot install anything, go to the fallback at the end.
2. Read the current install instructions at https://github.com/github/spec-kit (command syntax changes between versions). The usual command is:
   `uvx --from git+https://github.com/github/spec-kit.git specify init --here --ai <agent>`
   where `<agent>` is the coding agent you are running as (for example `gemini`, `claude`, `copilot`, `codex`, `cursor-agent`; `specify integration list` shows the valid keys in the installed version). Then run `specify check`.
3. IMPORTANT: it runs in an existing repo. Right after init, run `git status --short` and `git diff`. Make sure these were NOT overwritten or mangled: `AGENTS.md`, `CLAUDE.md`, `package.json`, `.gitignore`, existing docs. Restore any file that was changed unexpectedly (`git checkout -- <file>` is OK here because the change was made by the init command and you have not committed it).
4. Look at what was added: normally a `.specify/` folder, a `specs/` folder (created later per feature), and command files in the agent's command folder (for example `.gemini/commands/` for Gemini CLI, `.claude/commands/` for Claude Code) plus a context file (for example `GEMINI.md` or `CLAUDE.md`; check that it did not overwrite your own). List them. Write the REAL command names in DECISIONS.md (they may differ from `/speckit.specify` etc.).
5. Run the constitution command and give it this text (section 1 of this file is the source): "Rules: security first; every id from a client is ownership-checked and project-scoped; cross-tenant is 404; additive migrations only; failing test first; hermetic tests; structured logger only; no new dependencies without a decision; reuse existing patterns; one commit per task; never push; never edit my-app/. AGENTS.md wins on conflict."
6. Commit the init as its own commit: `phase-1(SETUP-2)`.
7. Fallback: if Spec Kit cannot be installed or run (tooling, network), add `D-14` usage in DECISIONS.md ("Spec Kit unavailable, using the task cards of the phase files as spec") and continue. This is NOT a stop reason.

Acceptance for P-1: files exist, STATE.md lists all tasks, baseline `npm test` result recorded, two commits made.

### After SETUP-1 and SETUP-2

If `SPEC_KIT = ON`: do PREP-P0 now (`05_SPEC_KIT_GUIDE.md`) using THIS file as the spec, then STOP and wait for `GO`. If `SPEC_KIT = OFF`: go straight to task D2.6.

---

## 4. Phase P0: task D2.6

Background (from the review of D2.5, which was accepted with follow-ups): D2.5 added an in-flight upload cap (503 with `Retry-After`), `/health` showing Redis, SSRF protection on provider output, and a check of dangerous file types before the allow-list. D2.6 closes the remaining gaps. It is ONE task with five sub-items (a to e) and ONE commit `phase0(RC1.4-D2.6)`. You may use one commit per sub-item if AGENTS.md prefers it; then name them `phase0(RC1.4-D2.6a)` etc.

### D2.6(a): The internal secret must not be a universal impersonation key

**The problem in plain words.** Today (verify!), when a request carries a header `x-internal-secret` equal to `INTERNAL_SECRET`, the file `auth.js` trusts another header `x-user-id` and sets `req.user.id` from it. A path allow-list limits where this works, but the allow-list is very large (workflows, images, video, characters, projects, generations, assets, media/ingest, prompt/optimize). So anyone who knows the secret can act as ANY user, even call generation routes and spend that user's credits. Also, the only real user of this path appears to be `ElementVisionService`, which lives in the FRONTEND (`my-app`). A secret used by a browser app is not secret.

**Goal.** Make the internal path off by default, restricted to the exact requests a real caller needs, and logged.

**Step 1: find the real callers (evidence)**
Run all of these and write every hit as `file:line` in the scratch note:
```
rg -n "x-internal-secret|INTERNAL_SECRET|internalSecret|x-user-id" --glob '!node_modules' .
```
For every hit classify it as: READER (code that checks the header, like auth.js), CALLER (code that SENDS the header: a service, worker, script, test), or DOC. Only CALLERS matter for the allow-list. Search backend callers specifically: `rg -n "x-internal-secret" src/ lib/ workers/ scripts/ tests/` (adapt folder names to the repo).
Also look for HTTP clients that call the backend's own URL from inside the backend (for example `axios.get(process.env.API_URL ...)` with headers).

**Step 2: decide the case**
- Case 1: the only caller is `ElementVisionService` in `my-app`. Do steps 3 to 7 as written.
- Case 2: there are other real backend callers (a worker, a script). Keep only the exact method+path pairs each caller needs, document each with `file:line` of the caller, and still do steps 3, 4, 5, 6, 7.
- Case 3: there are NO callers at all. Same as case 1; additionally put in BACKLOG.md "consider deleting the internal-auth code".

**Step 3: add the on/off flag**
- The internal path is active ONLY if `process.env.INTERNAL_AUTH_ENABLED === "true"` (exact string). Unset, empty, "false", "1", "TRUE" all mean OFF.
- When OFF: the headers `x-internal-secret` and `x-user-id` are completely ignored, and the request continues through the normal JWT authentication as if the headers did not exist. Do not set `req.user`. Do not return a special error.
- Add `INTERNAL_AUTH_ENABLED` to the env documentation (`docs/release/phase0-rc.md` or the repo's env docs) with the line "must be unset or false in production".

**Step 4: restrict to exact method + path pairs**
Allowed pairs (Case 1):
- `GET  /api/workflows/project-data/:projectId`
- `PATCH /api/workflows/workflows/:id`

Nothing else. Specifically NOT: generation, billing, credits, characters, element-write, media ingest, prompt optimize.

How to match safely (this is where mistakes happen):
- Compare the HTTP method exactly (`req.method`).
- Take the path from the original URL as the client sent it, WITHOUT the query string. Be careful: when a router is mounted under a prefix, `req.path` may be relative. Check what `req.originalUrl` contains in a test and use the full path.
- Match with a strict, anchored regular expression: start `^`, end `$`, and a restricted id character set such as `[A-Za-z0-9_-]+` (if ids are UUIDs, use the UUID pattern). This automatically rejects `..`, `%2e`, `%2f`, extra slashes, and extra segments like `/project-data/x/../../images/generate`.
- Do NOT use `startsWith`, `includes`, or a prefix list.
- A trailing slash is NOT allowed (the strict regex refuses it; it simply falls through to JWT).

Illustration (adapt names; do not copy blindly):
```js
const INTERNAL_ALLOWED = [
  { method: 'GET',   pattern: /^\/api\/workflows\/project-data\/[A-Za-z0-9_-]+$/ },
  { method: 'PATCH', pattern: /^\/api\/workflows\/workflows\/[A-Za-z0-9_-]+$/ },
];

function internalAuthEnabled() {
  return process.env.INTERNAL_AUTH_ENABLED === 'true';
}

function secretMatches(provided, expected) {
  if (typeof provided !== 'string' || typeof expected !== 'string' || expected.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;      // timingSafeEqual throws on different lengths
  return crypto.timingSafeEqual(a, b);
}

function isAllowedInternalRequest(req) {
  const path = (req.originalUrl || req.url || '').split('?')[0];
  return INTERNAL_ALLOWED.some(r => r.method === req.method && r.pattern.test(path));
}
```

Other requirements for the internal path:
- Compare the secret with `crypto.timingSafeEqual` (as above). If the repo already does this, REUSED.
- Validate `x-user-id` format (for example UUID if user ids are UUIDs). Invalid format => ignore the internal path (fall through to JWT). Say in the report that format validation does not prove the user exists (INFERRED/known limitation); do not add a DB lookup in this task.
- Log every ACCEPTED use at info level with: route pattern (not the secret), method, userId. Use the structured logger. Log a REJECTED attempt (secret present but wrong, or method/path not allowed while the flag is on) at warn level with the reason code (`bad_secret`, `not_allowed`), never the secret value, never the provided header value.

**Step 5: tests (write them first, see them fail)**

| # | Given | When | Then |
|---|---|---|---|
| 1 | flag unset, correct secret, valid user id | GET allowed path | internal path ignored; request is treated as unauthenticated (401) |
| 2 | flag "false", correct secret | GET allowed path | ignored (401) |
| 3 | flag "true", WRONG secret | GET allowed path | ignored (401) and a warn log without the secret |
| 4 | flag "true", correct secret | POST on allowed path | ignored (method not allowed) |
| 5 | flag "true", correct secret | DELETE `/api/workflows/workflows/abc` | ignored |
| 6 | flag "true", correct secret | `POST /api/images/generate` (any generation route) | ignored |
| 7 | flag "true", correct secret | `/api/workflows/project-data/x/../images` and `/api/workflows/project-data/x%2F..%2Fimages` | ignored |
| 8 | flag "true", correct secret | `/api/workflows/project-data/abc/` (trailing slash) and `/api/workflows/project-data/abc/extra` | ignored |
| 9 | flag "true", correct secret, invalid user id format | allowed path | ignored |
| 10 | flag "true", correct secret, valid user id | `GET /api/workflows/project-data/abc` | accepted; `req.user.id` equals the header user id; info log written |
| 11 | flag "true", correct secret, valid user id | `PATCH /api/workflows/workflows/abc` | accepted |
| 12 | any accepted/rejected case | after the request | serialized logger calls do NOT contain the secret string |
| 13 | flag "true", NO secret header, valid JWT | any route | normal JWT authentication still works (regression) |

**Step 6: frontend note (documentation only, do NOT edit `my-app/`)**
In `docs/release/frontend-changes-needed.md` add a section "ElementVisionService: stop using the internal secret" with:
- Current behavior: it sends `x-internal-secret` and `x-user-id`.
- Required change: use the logged-in user's JWT (`Authorization: Bearer <access token>`, same way the other frontend services do) on exactly these two calls: `GET /api/workflows/project-data/:projectId` and `PATCH /api/workflows/workflows/:id`. Remove both internal headers. Remove `INTERNAL_SECRET` from every frontend env file and build config.
- Deploy order: ship the frontend change BEFORE (or together with) the backend release that turns the internal path off, otherwise element vision breaks.
- Check after deploy: element vision works for a normal logged-in user; the network tab shows no `x-internal-secret`.

**Step 7: reminder for the human (in the report)**
Rotate `INTERNAL_SECRET` (it was exposed to the frontend). Never put it in a frontend env.

**Common pitfalls**
- Forgetting that auth middleware order matters: the internal check must run in the same place as before, and when ignored it must call the normal JWT logic, not skip authentication.
- Matching on `req.path` inside a mounted router and getting a relative path, so the allow-list never matches (tests would show it: test 10 and 11 must pass).
- Using `===` for the secret comparison.
- Logging `req.headers` as a whole (that leaks the secret).

**Definition of done (a):** all 13 tests exist and pass, evidence list of callers in the report, docs updated, no secret in logs.

### D2.6(b): Split health into `/health` and `/ready`

**Plain words.** A load balancer must know two different things: "is the process alive?" (restart it if not) and "can it serve users now?" (stop sending traffic if not). A `/health` that returns `ok: true` even when Redis is down misleads the load balancer.

**Required behavior**
- `GET /health` (liveness): always 200 while the process runs. Body minimal, for example `{ "ok": true }`. It must NOT call Redis or the DB (so a dependency outage does not cause restarts).
- `GET /ready` (readiness): checks the rate-limit Redis and the queue Redis. If both ready: 200 with `{ "ready": true }`. If any is not ready: 503 with `{ "ready": false }`.
- For unauthenticated callers show NOTHING else: no Redis host, no error messages, no versions, no which dependency failed. (Details go to the structured logger at warn level, only when the state changes or at most once per N seconds, to avoid log floods.)
- The readiness check must be fast and safe: use the existing client "ready" state if the library exposes it; if you must `PING`, add a short timeout (for example 1000 to 2000 ms, from config) and cache the result for 1 to 2 seconds so a load balancer polling every second does not hammer Redis.

**Steps**
1. Find the current `/health` handler: `rg -n "/health" src/ lib/`. Read it and the Redis module (`redis.js`) to see how readiness can be known.
2. Write tests first: (1) `/health` returns 200 even if the Redis mock reports not ready, body has only `ok`; (2) `/ready` 200 when both ready; (3) `/ready` 503 when rate-limit Redis not ready; (4) `/ready` 503 when queue Redis not ready; (5) the 503 body contains only `ready:false` (assert exact body equality); (6) `/ready` does not throw when a Redis `ping` rejects (it returns 503).
3. Implement. Reuse the existing Redis clients; do not open new connections.
4. Docs: in `docs/release/phase0-rc.md`, write "Load balancer: health check target = `/ready`. Platform restart probe (liveness) = `/health`."

**Definition of done (b):** tests 1 to 6 pass; docs updated; `/ready` leaks no internals.

### D2.6(c): Structured logger instead of `console.*`

Files: `redis.js`, `sizeLimitedStorage.js`, `StorageService` (as named in notes; find the real files with `rg -l "StorageService|sizeLimitedStorage" src/ lib/`).

Steps:
1. Find the structured logger the rest of the code uses: `rg -n "require\(.*logger|from .*logger" src/ | head`. Open it and read its API (levels, how to pass fields, how it serializes errors). Copy the usage style from an existing file.
2. In each file, list every `console.*` call: `rg -n "console\." <file>`.
3. Replace each with the logger at the right level (`error` for failures, `warn` for degraded, `info` for normal events, `debug` for noise). Include only safe fields: a short message, error code, error message, a stable id. NEVER include: secrets, tokens, request bodies, prompts, full headers, signed URLs, full file contents, `err.config` or `err.request` objects from HTTP libraries (they contain headers and URLs with tokens).
4. Test: for each file add a test that the logger spy is called on the error path and that `console.error` is not called (spy on `console` to assert 0 calls). If a file has no existing test, create a small one for the specific error path you changed.
5. Verify: `rg -n "console\." <the three files>` prints nothing.

**Definition of done (c):** zero `console.*` in those files; logger calls carry no sensitive data; tests exist.

### D2.6(d): In-flight upload cap: sizing rule and docs

**Plain words.** The cap `MAX_IN_FLIGHT_UPLOAD_BYTES` (default 250MB) limits how many upload bytes the instance accepts at the same time, to protect RAM. With 100MB video uploads, only two fit; the third gets 503. The number must match the instance RAM, not be a random value.

**Steps**
1. Read `sizeLimitedStorage.js` and how uploads are received. Answer with evidence: are uploads BUFFERED IN MEMORY (for example multer `memoryStorage`, `Buffer.concat`) or STREAMED (to disk or straight to object storage)? This decides how important the cap is.
2. Verify the reservation logic is leak-free (this is the one place where you may change code): bytes reserved at the start MUST be released on every ending: success, error, client abort/disconnect, timeout. Search for where the counter is decremented. If any path can skip the release, write a failing test (simulate an aborted request) and fix it.
3. Verify `MAX_CONCURRENT_UPLOADS_PER_USER` exists and where it is enforced. Per-user concurrency limit must not be bypassable through a second request header.
4. Document in `docs/release/phase0-rc.md`:
   - What each variable means, its default, and where it is read.
   - Sizing rule: "in-flight cap is about 25% of instance RAM and never below 2 x the largest single allowed file (video 100MB means at least 200MB)".
   - Starting values (validate with a load test): 512MB RAM -> 128MB (NOTE: this is below 2 x 100MB, so on 512MB instances allow only one big upload at a time or avoid buffering); 1GB -> 250MB; 2GB -> 500MB; 4GB -> 1000MB. Per-user concurrent uploads: 2 to 3.
   - What the client sees when full: 503 + `Retry-After`.
5. No code change if steps 2 and 3 are fine. Say so in the report.

**Definition of done (d):** doc written with the table; leak check result reported with evidence; code changed only if a leak was proven by a failing test.

### D2.6(e): Replace the curl placeholder bucket name

**Problem.** The existing doc has a curl check for staging with a guessed bucket name (`generated_images`). A guessed value is not acceptable.

**Steps**
1. Find where stored files get their URL/path: read `StorageService` (methods like `upload`, `getPublicUrl`, `createSignedUrl`) and find the bucket name constant or env var (do NOT assume it): `rg -n "bucket|BUCKET" src/ lib/ .env.example`.
2. Find how a real stored-file URL can be obtained through our own API: a route that returns a media/asset record containing the URL (look at the media routes and their responses).
3. Write in the doc a procedure with two options:
   - Option 1 (API): "Call `GET <route>` as a logged-in user, copy the `url` field of a recent item."
   - Option 2 (DB, Supabase SQL editor, only if the storage is Supabase): `select bucket_id, name from storage.objects order by created_at desc limit 5;` then build the URL the way `StorageService` does (show the exact formula from the code).
4. Then the curl, with placeholders clearly written as `<REAL_URL_FROM_STEP_1>` (angle brackets, so nobody thinks they are real). The curl must check: HTTP status 200, `content-type` equals the expected media type, and the dangerous-type/SSRF behavior if the doc covers it.
5. Mark `NOT-RUN` in the report: the human runs it on staging and returns the result.

**Definition of done (e):** doc contains a real, derivable procedure; no guessed bucket names remain (`rg -n "generated_images" docs/` prints nothing, unless the code truly uses that name; then cite `file:line`).

### D2.6 acceptance (whole task)
- All sub-items done and reported; full hermetic `npm test` green; secrets scan clean; self-review score >= 85; commit(s) made; report written; STATE.md updated. Then go straight to D3.

---

## Phase end: gate and acceptance test

1. When every task above is DONE, BLOCKED or SKIPPED, run the phase gate (`00_CORE.md` section 10).
2. Phase acceptance test. Run each check and paste the results (command or test name + result, tagged VERIFIED / NOT-RUN) into `docs/plan/reports/PHASE-P0-GATE.md`:

Always: full hermetic `npm test` passes; `git status --short` clean (except `docs/plan/scratch/`); nothing pushed; every task of the phase has a report with tagged claims.

| Phase | Extra checks |
|---|---|
| P-1 + P0 | (1) The 13 internal-auth tests of D2.6(a) exist and pass. (2) With `INTERNAL_AUTH_ENABLED` unset, a request with the correct secret is ignored (test name). (3) `/health` returns 200 while the Redis mock is down; `/ready` returns 503 with body exactly `{ready:false}`. (4) `rg -n "console\." redis.js sizeLimitedStorage.js StorageService` (real paths) prints nothing. (5) `docs/release/phase0-rc.md` has the upload-cap sizing table and the reservation-leak result. (6) `docs/release/frontend-changes-needed.md` has the ElementVisionService section. (7) `rg -n "generated_images" docs/` prints nothing (or cites code). |

If any check fails: fix it inside the phase (same loop), re-run the phase acceptance test, then report. Do not stop with a failed check unless a stop reason of 1.5 applies.

3. Write the gate report, update STATE.md with `Next step: P1 (human gives you `02_P1_D3_verifications.md` in a new session)`, print a summary (max 15 lines) and STOP.
