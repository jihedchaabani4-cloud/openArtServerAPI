# Identity System (`identity.md`)

> Canonical specification for the backend Identity, Authentication, and Authorization Business System.
> Authored per Rule 15 (`docs/architecture/BUSINESS_SYSTEMS_RULES.md`) and Base Pass Checklist B5.
> All code citations cite verified `file:line`; facts not inspected are marked `UNVERIFIED`.

| Metadata | Value |
|---|---|
| **System Name** | `Identity` |
| **Tier** | `Foundation` |
| **Public Import Alias** | `#platform/identity` (`package.json:17`) |
| **Entry File** | `apiOpenArt/src/platform/identity/index.js` |
| **Base Error Class** | `IdentityError` (`src/platform/identity/IdentityErrors.js:9`) |
| **Audit Classification** | `SPLIT` & `REBUILD` |
| **Phase Status** | `Base Pass Verified` |

---

## 1. Purpose

- **Business Responsibility**: The Identity System owns user identification, credential verification, session token lifecycle (JWT access/refresh cookies), administrative privilege enforcement, S2S internal auth comparison, and user account metadata (`public.profiles`).
- **Qualification Proof (Rule 2)**:
  - **Persistent State Owned**: `auth.users` (managed by Supabase Auth engine), `public.profiles` (account record).
  - **External Consumers (>= 2)**: HTTP edge routes (`requireAuth`, `requireAdmin`), all domain controllers (`assertOwns`), and application lifecycle (`authController.ensureUserAccount`).
- **Explicit Non-Goals**:
  - Entity-level resource ownership (`workflow`, `project`, `media`, `element`, `character`) belongs to domain systems or `Workspace` authorization.
  - Credit package authorization and balances belong exclusively to `Billing`.

---

## 2. Owned Database Tables & SQL RPCs (Rule 5)

| Postgres Table / Entity | Storage / Repository | Key Invariants / Constraints |
|---|---|---|
| `auth.users` | Supabase Auth API (`supabase.auth`) | Owned by Supabase Auth engine; holds credentials, emails, and `app_metadata.role`. |
| `public.profiles` | Direct `controllers/authController.js:86` SQL | `id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE`. User account metadata. |

---

## 3. Internal Services & Modules

1. **`src/platform/identity/IdentityErrors.js`**: Typed error hierarchy inheriting `AppError`.
2. **`src/platform/security/ownership.js`**: Resource ownership assertion guards (`assertOwns`, `assertOwnsAny`, `toMediaIdList`, `setDb`).
3. **`src/platform/security/secretComparison.js`**: Constant-time timing-safe secret comparison (`safeCompareSecret`).
4. **`src/middleware/auth.js`**: Cookie/Bearer session authentication (`requireAuth`), S2S bypass logic (`isInternalSecretAllowedRequest`, `isInternalSecretAllowedRoute`, `USER_ID_REGEX`).
5. **`src/middleware/requireAdmin.js`**: Admin role verification middleware (`requireAdmin`).
6. **`src/platform/security/AuthorizationService.js`**: Static RBAC capability checker (`can`, `assertCan`).
7. **`src/platform/security/TenantAccessService.js`**: Project-level ownership assertion (`assertProjectOwnership`).
8. **`src/platform/security/AuditService.js`**: Security audit log dispatcher (`log`).

---

## 4. Public API (Exports on `#platform/identity`)

Exported exclusively from `apiOpenArt/src/platform/identity/index.js`:
- **Errors**: `IdentityError`, `IdentityAuthenticationError`, `IdentityForbiddenError`, `IdentityNotFoundError`, `IdentityValidationError`
- **Ownership Guards**: `assertOwns`, `assertOwnsAny`, `toMediaIdList`, `setDb`
- **Security Utilities**: `safeCompareSecret`
- **Middleware**: `requireAuth`, `requireAdmin`, `isInternalSecretAllowedRequest`, `isInternalSecretAllowedRoute`, `USER_ID_REGEX`
- **Platform Services**: `AuthorizationService`, `TenantAccessService`, `AuditService`

---

## 5. Allowed Dependencies

- **Dependencies Point Downward Only (Rule 1)**:
  - Allowed: Node core modules (`crypto`), `@supabase/supabase-js`, `src/infrastructure/logging`, `src/errors/AppError.js`.
  - Zero imports from Upper Domain systems (`character`, `element`, `generation`, `workflow`, `media`).
  - Container-level dependency injection: `assertOwns` accesses repository interfaces via `container.db` or explicit `setDb()`.

---

## 6. Known Gaps & Technical Debt (Links to BACKLOG.md)

| Backlog ID | Severity | Summary | Citation |
|---|---|---|---|
| `SEC-ID-01` | **HIGH** | `lib/supabase.js`: `supabase`, `supabaseAdmin`, and `createRequestBoundClient` share service-role key; RLS protects nothing in backend. | `lib/supabase.js:5` |
| `SEC-ID-02` | **HIGH** | `BaseRepository.findById/updateFields/delete` query by ID with zero `user_id` filtering; tenancy relies 100% on application code. | `src/db/BaseRepository.js:13` |
| `SEC-ID-03` | **LOW** | `requireAdmin.js` instantiates redundant `createClient` and uses `console.error`. | `src/middleware/requireAdmin.js:20, 61` |
| `ORPHAN-SEC-01` | **LOW** | `AuthorizationService`, `TenantAccessService`, `AuditService` have zero production callers. | `src/platform/security/AuthorizationService.js:42` |

---

## 7. Open Decisions for Human Approval

1. **`WorkflowAuthorizationService` Home (Identity vs Workspace)**:
   - *Code Evidence*: `src/platform/workflow/WorkflowAuthorizationService.js:45-48` queries `.from("workflow").select("id, project:project!project_id(user_id)").in("id", cleanIds)`.
   - *Finding*: `WorkflowAuthorizationService` checks workflow-to-project ownership. It does NOT belong to `Identity` (which owns user credentials and sessions); it belongs to **`Workspace`** (which owns projects, folders, and workflows).
   - *Status*: Kept in place during Base Pass; awaiting human confirmation to formalize its placement in Workspace.
2. **Retire or Wire Orphaned Platform Security Services**:
   - `AuthorizationService`, `TenantAccessService`, and `AuditService` have 0 callers (`ORPHAN-SEC-01`).
   - *Decision*: Retire (delete) or wire into future authorization middleware during the Identity depth pass.
3. **`public.profiles` Repository Extraction**:
   - *Decision*: Extract raw `.from("profiles")` queries from `controllers/authController.js:88` into a private `ProfileRepository` owned by Identity.
