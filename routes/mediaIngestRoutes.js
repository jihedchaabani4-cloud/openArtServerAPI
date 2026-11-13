/**
 * Legacy Re-export for mediaIngestRoutes.
 * Canonical gateway now lives in src/systems/media/public/api.js (#media/api)
 */
import {
    mediaIngestRouter,
    handleMediaIngest,
} from "#media/api";

export {
    mediaIngestRouter,
    handleMediaIngest,
};

export default mediaIngestRouter;
