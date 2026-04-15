import { PromptService } from "#services/PromptService.js";
import { StorageService } from "#services/StorageService.js";
import { VisionService } from "#services/VisionService.js";

// ─── Repositories ───────────────────────────────────────────────────────────
import { ProjectRepository }          from "#db/ProjectRepository.js";
import { SessionRepository }          from "#db/SessionRepository.js";
import { BatchRepository }            from "#db/BatchRepository.js";
import { WorkflowRepository }         from "#db/WorkflowRepository.js";
import { MediaRepository }            from "#db/MediaRepository.js";
import { GenerationConfigRepository } from "#db/GenerationConfigRepository.js";

// ─── Video Domain ────────────────────────────────────────────────────────────
import { VideoTreatment }  from "#video/treatments/VideoTreatment.js";
import { MotionTreatment } from "#video/treatments/MotionTreatment.js";
import { EditVideoTreatment } from "#video/treatments/EditVideoTreatment.js";

// ─── Image Domain ────────────────────────────────────────────────────────────
import { GenerateImageTreatment } from "#image/treatments/ImageTreatment.js";
import { MultiShotTreatment }     from "#image/treatments/MultiShotTreatment.js";
import { EditImageTreatment }      from "#image/treatments/EditImageTreatment.js";
import { CameraTreatment }         from "#image/treatments/CameraTreatment.js";
import { LightingTreatment }       from "#image/treatments/LightingTreatment.js";
import { UpscaleTreatment }        from "#image/treatments/UpscaleTreatment.js";
import { MODELS as IMAGE_MODELS } from "#image/core/registry.js";

// ─── Providers ───────────────────────────────────────────────────────────────
import { OpenAITextProvider } from "./core/providers/OpenAITextProvider.js";
import { GroqProvider }       from "./core/providers/GroqProvider.js";

// ─── Init Providers ──────────────────────────────────────────────────────────
const openai = process.env.OPENAI_API_KEY ? new OpenAITextProvider(process.env.OPENAI_API_KEY) : null;
const groq   = new GroqProvider(process.env.GROQ_API_KEY);

// ─── Services ────────────────────────────────────────────────────────────────
export const promptService  = new PromptService(groq);
export const storageService = new StorageService();
export const visionService  = new VisionService(groq);

// ─── DB (new 7-table schema) ─────────────────────────────────────────────────
export const db = {
    projects:  new ProjectRepository(),   // table: project
    sessions:  new SessionRepository(),   // table: session
    batches:   new BatchRepository(),     // table: batch
    workflows: new WorkflowRepository(),  // table: workflow
    media:     new MediaRepository(),     // table: media
    configs:   new GenerationConfigRepository(), // tables: generation_config + generation_config_reference
};

// ─── Treatments ──────────────────────────────────────────────────────────────

export const videoTreatment = new VideoTreatment({
    promptService, storageService, db
});

export const motionTreatment = new MotionTreatment({
    promptService, storageService, db
});

export const editVideoTreatment = new EditVideoTreatment({
    promptService, storageService, db
});

export const imageTreatment = new GenerateImageTreatment({
    promptService, models: IMAGE_MODELS, storageService, db
});

export const multiShotTreatment = new MultiShotTreatment({
    promptService, models: IMAGE_MODELS, storageService, db
});

export const editImageTreatment = new EditImageTreatment({
    promptService, models: IMAGE_MODELS, storageService, db
});

export const cameraTreatment = new CameraTreatment({
    promptService, models: IMAGE_MODELS, storageService, db
});

export const lightingTreatment = new LightingTreatment({
    promptService, models: IMAGE_MODELS, storageService, db
});

export const upscaleTreatment = new UpscaleTreatment({
    storageService, db
});
