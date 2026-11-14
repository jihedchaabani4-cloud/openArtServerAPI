/**
 * mediaMetadataResolver (Legacy Re-export)
 * Canonical implementation now lives in src/systems/media/internal/services/mediaMetadataResolver.js
 * accessible via #media/tools.
 */
import {
    resolveMediaMetadata,
    calculateAspectRatio,
} from "#media/tools";

export {
    resolveMediaMetadata,
    calculateAspectRatio,
};
export default {
    resolveMediaMetadata,
    calculateAspectRatio,
};
