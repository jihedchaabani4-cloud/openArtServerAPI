# Ticket 2.3: Public Gateways, Package Subpath Imports & Legacy Re-exports (`public/`, `package.json`)

## 1. Description & Context
Build the two public gateways for Identity:
- `src/systems/identity/public/api.js`: Express router mounting all HTTP auth endpoints (`/signup`, `/login`, `/google`, `/microsoft`, `/callback`, `/me`, `/logout`, `/wallet/balance`).
- `src/systems/identity/public/tools.js`: Public async tools interface (`verifySession`, `getUserProfile`, `assertOwns`, `assertOwnsAny`, `requireAuth`, `requireAdmin`, `safeCompareSecret`).

Update `package.json#imports` to register:
- `"#identity/api": "./src/systems/identity/public/api.js"`
- `"#identity/tools": "./src/systems/identity/public/tools.js"`

Wire legacy re-exports so existing code continues working transparently.

## 2. Inviolable Requirements
1. **Rule 13 Compliance**: `express` is imported ONLY in `public/api.js`.
2. **Rule 15 Compliance**: `package.json#imports` contains explicit mappings to `public/api.js` and `public/tools.js` without wildcards.
3. **No Regressions**: All 1,372 tests must pass, and `npm run arch` must pass with 0 new violations.

## 3. Test Coverage
- `tests/unit/identitySystem.test.js` validating `#identity/tools` and `#identity/api`.
