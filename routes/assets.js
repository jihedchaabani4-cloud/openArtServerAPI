/**
 * Legacy Re-export for assetsRouter.
 * Canonical gateway now lives in src/systems/media/public/api.js (#media/api)
 */
import {
    assetsRouter,
    handleAssetUpload,
    handleDeleteMedia,
    handleMoveToFolder,
} from "#media/api";

export {
    assetsRouter,
    handleAssetUpload,
    handleDeleteMedia,
    handleMoveToFolder,
};

export default assetsRouter;
