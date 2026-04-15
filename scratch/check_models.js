import { isVideoModelRegistered } from '../lib/modelRegistryKeys.js';
import { MODEL_ROUTES, AVAILABLE_MODELS } from '../src/video/core/modelRouter.js';

console.log("Checking kling_o3:");
console.log("In MODEL_ROUTES:", !!MODEL_ROUTES["kling_o3"]);
console.log("In AVAILABLE_MODELS:", AVAILABLE_MODELS.includes("kling_o3"));
console.log("isVideoModelRegistered('kling_o3'):", isVideoModelRegistered("kling_o3"));
