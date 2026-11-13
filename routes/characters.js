/**
 * Legacy Re-export for characters routes.
 * Canonical gateway now lives in src/systems/characters/public/api.js (#characters/api).
 */
import router, { characterController } from "#characters/api";

export { characterController };
export default router;
