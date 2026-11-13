# Design Document — Partie 02: System 5 — Identity & Auth (`src/systems/identity/`)

> **Architectural Standard**: Modular Monolith Constitution (`01_business_systems_architecture.md`, `02_architecture_rules_and_agent_guardrails.md`)  
> **Status**: APPROVED  
> **Target Directory**: `src/systems/identity/`

---

## 1. Executive Summary & Objective

Partie 02 establishes the first black-box Business System: **System 5: Identity & Auth** (`src/systems/identity/`).
It encapsulates:
- User authentication (Email/Password signup and login)
- OAuth flows (Google & Microsoft redirects and callback handling)
- Cross-domain session cookie management (`access_token`, `refresh_token`)
- User profile persistence in the `profiles` table
- Ownership verification (`assertOwns`, `assertOwnsAny`)
- Request authentication and authorization middlewares (`requireAuth`, `requireAdmin`, S2S secret comparison)

All external callers interact strictly through:
- `public/api.js` (`#identity/api`): Mounted by HTTP routers for `/api/auth/*`.
- `public/tools.js` (`#identity/tools`): Async DTO functions (`verifySession`, `getUserProfile`, `assertOwns`, `requireAuth`).

---

## 2. Inviolable Boundary & Purity Rules

1. **Two-Gateway Entry Points**: External callers and background workers may ONLY import `#identity/api` or `#identity/tools`. No file outside `src/systems/identity/` may import `internal/`.
2. **Database & SDK Isolation (Rule 12)**: `supabase` is imported ONLY inside `src/systems/identity/internal/db/` (`ProfileRepository.js` and `authClient.js`).
3. **Web Framework Isolation (Rule 13)**: Express is imported ONLY in `public/api.js`. Internal services and repositories never import Express.
4. **No Internal-to-Gateway Calls (Rule 7 & 11)**: Files inside `internal/` must never import `public/api.js` or `public/tools.js`.
5. **DTO Boundary (Rule 8)**: `public/tools.js` exchanges plain JSON-serializable DTOs.
6. **100% Backward Compatibility**: `routes/authRoutes.js`, `controllers/authController.js`, `src/middleware/auth.js`, and `src/platform/identity/index.js` re-export from the new system gateways.

---

## 3. Directory Layout

```text
src/systems/identity/
├── public/
│   ├── api.js                # Express router mounted by app (#identity/api)
│   └── tools.js              # Pure async DTO tools & middlewares (#identity/tools)
└── internal/
    ├── db/
    │   ├── authClient.js     # Supabase Auth client wrapper (Rule 12 compliant)
    │   └── ProfileRepository.js # DB repository for the profiles table
    ├── services/
    │   ├── AuthService.js    # signup, login, session resolution, ensureUserAccount
    │   ├── OAuthService.js   # OAuth provider sign-in & code exchange
    │   └── OwnershipService.js # assertOwns & assertOwnsAny ownership assertions
    ├── cookies.js            # Secure cross-origin cookie setters / clearers
    └── errors.js             # IdentityError, IdentityAuthenticationError, etc.
```

---

## 4. Tickets Breakdown

- **Ticket 2.1: Identity Errors & Internal DB Layer (`internal/db/`, `internal/errors.js`)**
  - Define `IdentityError` hierarchy in `internal/errors.js`.
  - Implement `internal/db/authClient.js` and `internal/db/ProfileRepository.js` owning the `profiles` table.
- **Ticket 2.2: Internal Services & Cookie Management (`internal/services/`, `internal/cookies.js`)**
  - Implement `AuthService` (signup, login, resolveUserFromCookies, ensureUserAccount, logout).
  - Implement `OAuthService` (googleRedirect, microsoftRedirect, googleCallback).
  - Implement `OwnershipService` (assertOwns, assertOwnsAny).
  - Implement `cookies.js` (setAuthCookies, clearAuthCookies).
- **Ticket 2.3: Public Gateways, Package Subpath Imports & Legacy Re-exports (`public/`, `package.json`)**
  - Implement `public/api.js` with Express router (`/signup`, `/login`, `/google`, `/microsoft`, `/callback`, `/me`, `/logout`, `/wallet/balance`).
  - Implement `public/tools.js` (`verifySession`, `getUserProfile`, `assertOwns`, `requireAuth`, `requireAdmin`, `safeCompareSecret`).
  - Add `#identity/api` and `#identity/tools` to `package.json#imports`.
  - Re-export in legacy files `routes/authRoutes.js`, `controllers/authController.js`, `src/platform/identity/index.js`, `src/middleware/auth.js`.
  - Add unit and boundary tests in `tests/unit/identitySystem.test.js`.
