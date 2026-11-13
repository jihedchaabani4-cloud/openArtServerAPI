# Ticket 2.2: Internal Services & Cookie Management (`internal/services/`, `internal/cookies.js`)

## 1. Description & Context
Implement internal services for the identity system:
- `src/systems/identity/internal/cookies.js`: `setAuthCookies(res, session)`, `clearAuthCookies(res)`.
- `src/systems/identity/internal/services/AuthService.js`: Email/password validation, signup, login, session extraction from cookies, `ensureUserAccount(userId, extra)`.
- `src/systems/identity/internal/services/OAuthService.js`: Google and Microsoft OAuth redirect URLs and code exchange.
- `src/systems/identity/internal/services/OwnershipService.js`: `assertOwns` and `assertOwnsAny` resource ownership assertions.

## 2. Inviolable Requirements
1. **Purity**: Zero Express framework dependencies inside `AuthService`, `OAuthService`, and `OwnershipService`.
2. **Zero Direct Supabase Imports**: All DB and Auth operations route through `internal/db/`.
3. **Structured Logging**: Use `createLogger("identity")` from `#shared`.

## 3. Test Coverage
- Unit testing of AuthService, OAuthService, and OwnershipService in `tests/unit/identitySystem.test.js`.
