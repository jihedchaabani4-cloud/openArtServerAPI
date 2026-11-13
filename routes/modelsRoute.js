/**
 * Legacy Re-export for modelsRoute.
 * Canonical gateway now lives in src/systems/models/public/api.js (#models/api)
 */
import router, { formatModelDto } from "#models/api";

export { formatModelDto };
export default router;
