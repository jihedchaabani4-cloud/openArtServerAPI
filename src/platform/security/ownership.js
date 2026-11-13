/**
 * Legacy Re-export for ownership verification.
 * Canonical implementation now lives in src/systems/identity/internal/services/OwnershipService.js
 * and is exposed publicly via #identity/tools.
 */
export {
  assertOwns,
  assertOwnsAny,
  toMediaIdList,
  setDb,
} from "../../systems/identity/public/tools.js";
