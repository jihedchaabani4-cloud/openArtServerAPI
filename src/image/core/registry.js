/**
 * ─── Image Model Registry (Merger) ───────────────────────────────────────────
 *
 * This file merges models from all per-runner registries into a single MODELS
 * export, consumed by:
 *   - modelsRoute.js  → /api/models endpoint
 *   - imageRouter.js  → group metadata for each route entry
 *   - container.js    → DI setup (legacy fallback)
 *
 * To add a new provider's model to the global registry:
 *   1. Define the runner in   src/image/runners/<provider>/models/<model>.js
 *   2. Add its ModelGroup to  src/image/runners/<provider>/registry.js
 *   3. It will show up here automatically via the spread below.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { MODELS as wavespeedModels } from "../runners/wavespeed/registry.js";
import { MODELS as sdxlModels      } from "../runners/sdxl/registry.js";
import { MODELS as falModels        } from "../runners/fal/registry.js";
import { MODELS as replicateModels  } from "../runners/replicate/registry.js";
import { MODELS as googleModels     } from "../runners/google/registry.js";

export const MODELS = {
    ...wavespeedModels,
    ...sdxlModels,
    ...falModels,
    ...replicateModels,
    ...googleModels,
};

export const AVAILABLE_IMAGE_MODELS = Object.keys(MODELS);
