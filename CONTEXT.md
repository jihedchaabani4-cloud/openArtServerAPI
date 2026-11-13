# CONTEXT.md — apiOpenArt Architecture Context & State

## 1. Project Identity
- **Application**: `apiOpenArt` (Labveil AI Studio Backend)
- **Current Branch**: `refactory-new-arch`
- **Architecture Standard**: Strict Modular Monolith (Shopify Packwerk style) governed by:
  - `docs/architecture/constitution/01_business_systems_architecture.md` (The 8 Business Systems)
  - `docs/architecture/constitution/02_architecture_rules_and_agent_guardrails.md` (The 12 Architecture Rules)
  - `docs/architecture/constitution/03_software_factory_master_prompt_and_plan.md` (Software Factory Plan)

## 2. Active Phase: Partie 02 (COMPLETED) -> Ready for Partie 03
- **Goal**: Build the first foundation black-box system (`identity`) owning Google OAuth, cookies, user profiles, and `assertOwns()`.
- **Results**:
  - `src/systems/identity/public/api.js` (`#identity/api`) mounted for `/api/auth/*`.
  - `src/systems/identity/public/tools.js` (`#identity/tools`) exposing `verifySession`, `getUserProfile`, `assertOwns`, `assertOwnsAny`, `toMediaIdList`, `requireAuth`, `requireAdmin`.
  - Database access to `profiles` strictly isolated to `src/systems/identity/internal/db/ProfileRepository.js`.
  - Supabase Auth SDK calls strictly isolated to `src/systems/identity/internal/db/authClient.js`.
  - Express isolated exclusively to `public/api.js`.
  - `#identity/api` and `#identity/tools` registered in `package.json#imports`.
  - 100% backward compatibility preserved for `routes/authRoutes.js`, `controllers/authController.js`, `src/platform/identity/index.js`, and `src/platform/security/ownership.js`.
- **Suite Status**: 1,379 tests passing (0 failures), Gate PASS.

## 3. Active Tickets Roadmap
- [x] **Ticket 2.1**: Identity Errors & Internal DB Layer (`internal/db/`, `internal/errors.js`) [DONE]
- [x] **Ticket 2.2**: Internal Services & Cookie Management (`internal/services/`, `internal/cookies.js`) [DONE]
- [x] **Ticket 2.3**: Public Gateways, Package Subpath Imports & Legacy Re-exports (`public/`, `package.json`) [DONE]
