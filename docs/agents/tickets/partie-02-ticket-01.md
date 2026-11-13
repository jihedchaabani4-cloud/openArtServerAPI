# Ticket 2.1: Identity Errors & Internal DB Layer (`internal/db/`, `internal/errors.js`)

## 1. Description & Context
Create `src/systems/identity/internal/errors.js` containing `IdentityError`, `IdentityAuthenticationError`, `IdentityForbiddenError`, `IdentityNotFoundError`, and `IdentityValidationError`.
Create `src/systems/identity/internal/db/authClient.js` and `src/systems/identity/internal/db/ProfileRepository.js` encapsulating all Supabase database and Auth calls to comply strictly with Rule 12.

## 2. Inviolable Requirements
1. **Rule 12 Compliance**:
   - `supabase` and `createRequestBoundClient` must be imported exclusively inside `src/systems/identity/internal/db/`.
2. **ProfileRepository**:
   - Exposes `upsertProfile(userId, extra)` and `findById(userId)`.
   - Owns all queries to the `profiles` table.
3. **Identity Errors**:
   - Subclasses of `AppError` from `#shared`.
4. **Zero Imports from Public Gateways**:
   - `internal/` must never import `public/api.js` or `public/tools.js`.

## 3. Test Coverage
- Unit testing of ProfileRepository and error construction in `tests/unit/identitySystem.test.js`.
