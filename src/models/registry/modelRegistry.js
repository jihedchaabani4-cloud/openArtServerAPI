import path from "path";
import { fileURLToPath } from "url";
import {
  initRegistry as initInternalRegistry,
  getRegistry,
  getModel,
  getModelBindings,
  getProvider,
  reloadRegistry as reloadInternalRegistry,
} from "#models/tools";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const LEGACY_MODELS_ROOT = path.resolve(__dirname, "..");

export function initRegistry(options = {}) {
  return initInternalRegistry({ rootDir: LEGACY_MODELS_ROOT, ...options });
}

export function reloadRegistry(options = {}) {
  return reloadInternalRegistry({ rootDir: LEGACY_MODELS_ROOT, ...options });
}

export {
  getRegistry,
  getModel,
  getModelBindings,
  getProvider,
};
