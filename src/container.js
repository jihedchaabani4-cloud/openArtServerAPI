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
import { DnaRepository }              from "#db/DnaRepository.js";

// ─── Video Domain ────────────────────────────────────────────────────────────
import { VideoTreatment }  from "#video/treatments/VideoTreatment.js";
import { MotionTreatment } from "#video/treatments/MotionTreatment.js";
import { EditVideoTreatment } from "#video/treatments/EditVideoTreatment.js";


import { EditImageTreatment }      from "#image/treatments/extendtretment/EditImageTreatment.js";
import { CameraTreatment }         from "#image/treatments/extendtretment/cameraEdittretment.js";
import { LightingTreatment }       from "#image/treatments/LightingTreatment.js";
import { UpscaleTreatment }        from "#image/treatments/UpscaleTreatment.js";
import { GenerateImageTreatment as ImageTreatmentV2 } from "#image/treatments/imagetretmentwithRadis.js";
import { ElementSheetTreatment }   from "#image/treatments/ElementSheetTreatment.js";
import { MODELS as IMAGE_MODELS } from "#image/core/registry.js";
export { IMAGE_MODELS };

// ─── DNA Domain ───────────────────────────────────────────────────────────────
import { DnaTreatment } from "./dna/DnaTreatment.js";

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
    dna:       new DnaRepository(),       // table: dna
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


export const imageTreatmentV2 = new ImageTreatmentV2({
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

export const dnaTreatment = new DnaTreatment({
    promptService, db
});

export const elementSheetTreatment = new ElementSheetTreatment({
    promptService, models: IMAGE_MODELS, storageService, db, dnaTreatment
});
