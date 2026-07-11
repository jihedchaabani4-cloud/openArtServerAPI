import {
  db,
  storageService,
  promptService,
  IMAGE_MODELS as models,
  dnaTreatment,
  walletService,
} from "../container.js";

// Legacy treatments have been deleted and migrated to V2 workflows.
// Stub classes are provided to prevent ERR_MODULE_NOT_FOUND during bootstrap.
class DeprecatedTreatment {
  constructor(deps) {
    this.deps = deps;
  }
  async runJob() {
    throw new Error("This legacy treatment is deprecated and deleted. Use V2 workflows instead.");
  }
}

class GenerateImageTreatment {
  constructor(deps) {
    this.deps = deps;
  }

  async runJob() {
    throw new Error("This legacy treatment is deprecated. Use V2 workflows instead.");
  }

  async prepareContext(currentContext, options = {}) {
    const { promptService } = this.deps;
    const prompt = currentContext.prompt;
    if (!prompt) return currentContext;

    console.log(`🛡️ [GenerateImageTreatment] Safety checking prompt: "${prompt.substring(0, 60)}..."`);
    
    // 1. Safety check
    const safety = await promptService.checkPrompt(prompt);
    if (!safety.safe) {
      console.warn(`❌ [GenerateImageTreatment] Prompt violation: ${safety.reason}`);
      throw new Error(`Prompt rejected: ${safety.reason}`);
    }

    // 2. Enhance/optimize prompt
    console.log(`✏️ [GenerateImageTreatment] Optimizing prompt...`);
    const enhanced = await promptService.optimizePrompt(prompt, { mode: "image" });
    const finalPrompt = enhanced?.optimized || prompt;

    // 3. Generate negative prompt
    const autoNeg = await promptService.generateNegativePrompt(finalPrompt);
    const finalNegative = [currentContext.negative_prompt || "", autoNeg || ""].filter(Boolean).join(", ");

    console.log(`✅ [GenerateImageTreatment] Prompt optimized successfully.`);
    return {
      ...currentContext,
      prompt: finalPrompt,
      negative_prompt: finalNegative,
    };
  }
}

class VideoTreatment {
  constructor(deps) {
    this.deps = deps;
  }

  async runJob() {
    throw new Error("This legacy treatment is deprecated. Use V2 workflows instead.");
  }

  async prepareContext(currentContext, options = {}) {
    const { promptService } = this.deps;
    const prompt = currentContext.prompt;
    if (!prompt) return currentContext;

    console.log(`🛡️ [VideoTreatment] Safety checking video prompt: "${prompt.substring(0, 60)}..."`);

    const { processVideoPrompt } = await import("../services/promptServiceV2.js");
    const textProvider = promptService.textProvider;

    const result = await processVideoPrompt({
      prompt,
      references: currentContext.references || [],
      modelType: currentContext.model_name || "kling",
      textProvider,
      videoMode: currentContext.mode || "t2v",
    });

    if (!result.safety) {
      console.warn(`❌ [VideoTreatment] Video prompt violation: ${result.reason}`);
      throw new Error(`Video prompt rejected: ${result.reason}`);
    }

    console.log(`✅ [VideoTreatment] Video prompt processed successfully.`);
    return {
      ...currentContext,
      prompt: result.prompt || prompt,
    };
  }
}

const EditImageTreatment = DeprecatedTreatment;
const CameraTreatment = DeprecatedTreatment;
const LightingTreatment = DeprecatedTreatment;
const UpscaleTreatment = DeprecatedTreatment;
const ElementSheetTreatment = DeprecatedTreatment;
const MotionTreatment = DeprecatedTreatment;
const EditVideoTreatment = DeprecatedTreatment;

export const treatmentDeps = {
  db,
  storageService,
  promptService,
  models,
  dnaTreatment,
  walletService,
};

export function createTreatmentRegistry(deps = treatmentDeps) {
  return {
    GenerateImageTreatment: new GenerateImageTreatment(deps),
    EditImageTreatment: new EditImageTreatment(deps),
    CameraTreatment: new CameraTreatment(deps),
    LightingTreatment: new LightingTreatment(deps),
    UpscaleTreatment: new UpscaleTreatment(deps),
    ElementSheetTreatment: new ElementSheetTreatment(deps),
    VideoTreatment: new VideoTreatment(deps),
    MotionTreatment: new MotionTreatment(deps),
    EditVideoTreatment: new EditVideoTreatment(deps),
  };
}

export function resolveTreatment(type, deps = treatmentDeps) {
  const treatments = createTreatmentRegistry(deps);
  const treatment = treatments[type];

  if (!treatment) {
    throw new Error(`Unknown treatment type "${type}"`);
  }

  return treatment;
}
