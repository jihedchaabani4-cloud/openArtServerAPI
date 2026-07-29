import "dotenv/config";
import { PromptService } from "#services/PromptService.js";
import { StorageService } from "#services/StorageService.js";
import { VisionService } from "#services/VisionService.js";
import { WalletService } from "#services/WalletService.js";
import { PricingService } from "#services/PricingService.js";
import { FailedOpsService } from "#services/FailedOpsService.js";
import { createClient } from "@supabase/supabase-js";
import { redisConnection } from "#queue/redis.js";

// ─── Repositories ───────────────────────────────────────────────────────────
import { ProjectRepository }          from "#db/ProjectRepository.js";
import { SessionRepository }          from "#db/SessionRepository.js";
import { BatchRepository }            from "#db/BatchRepository.js";
import { WorkflowRepository }         from "#db/WorkflowRepository.js";
import { MediaRepository }            from "#db/MediaRepository.js";
import { GenerationConfigRepository } from "#db/GenerationConfigRepository.js";
import { DnaRepository }              from "#db/DnaRepository.js";
import { CharacterRepository }        from "#db/CharacterRepository.js";

// VideoTreatment and GenerateImageTreatment removed — V2 adapters now route directly to model runners.
import { MODELS as IMAGE_MODELS } from "#image/core/registry.js";
export { IMAGE_MODELS };

// ─── DNA Domain ───────────────────────────────────────────────────────────────
import { DnaTreatment } from "./dna/DnaTreatment.js";
import { WorkflowEventRecorder } from "./infrastructure/events/workflowEventRecorder.js";
import { WorkflowBillingGateway } from "./infrastructure/billing/workflowBillingGateway.js";
import { MediaWorkflowLifecycleService } from "#services/MediaWorkflowLifecycleService.js";
import { WorkflowStorageGateway } from "./infrastructure/storage/workflowStorageGateway.js";
import { WorkflowQueueGateway } from "./infrastructure/queue/workflowQueueGateway.js";
import { WorkflowExecutionRepository } from "./workflows/workflowExecutionRepository.js";
import { WorkflowRunner } from "./workflows/workflowRunner.js";
import { WorkflowStatusService } from "./workflows/workflowStatusService.js";

// ─── Providers ───────────────────────────────────────────────────────────────
import { OpenAITextProvider } from "./core/providers/OpenAITextProvider.js";
import { GroqProvider }       from "./core/providers/GroqProvider.js";
import { registerProviders } from "./providers/providerRegistry.js";

// ─── Init Providers ──────────────────────────────────────────────────────────
const openai = process.env.OPENAI_API_KEY ? new OpenAITextProvider(process.env.OPENAI_API_KEY) : null;
const groq   = new GroqProvider(process.env.GROQ_API_KEY);

// ─── Services ────────────────────────────────────────────────────────────────
export const promptService  = new PromptService(groq);
export const storageService = new StorageService();
export const visionService  = new VisionService(groq);
const walletServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || null;
export const walletService  = process.env.SUPABASE_URL && walletServiceKey
    ? new WalletService(process.env.SUPABASE_URL, walletServiceKey)
    : null;

if (walletService) {
    console.log("[Container] WalletService initialized.");
} else {
    console.warn("[Container] WalletService disabled: missing SUPABASE_URL or service key.");
}

// ─── Pricing Service (DB-backed + Redis cache) ────────────────────────────────
const _supabaseForPricing = process.env.SUPABASE_URL && walletServiceKey
    ? createClient(process.env.SUPABASE_URL, walletServiceKey)
    : null;
export const pricingService = _supabaseForPricing
    ? new PricingService(_supabaseForPricing, redisConnection)
    : null;

if (pricingService) {
    console.log("[Container] PricingService initialized.");
} else {
    console.warn("[Container] PricingService disabled: missing Supabase config.");
}

// ─── Failed Operations Service ────────────────────────────────────────────────
export const failedOpsService = process.env.SUPABASE_URL && walletServiceKey
    ? new FailedOpsService(process.env.SUPABASE_URL, walletServiceKey)
    : null;

if (failedOpsService) {
    console.log("[Container] FailedOpsService initialized.");
} else {
    console.warn("[Container] FailedOpsService disabled: missing Supabase config.");
}

// ─── DB (new 7-table schema) ─────────────────────────────────────────────────
export const db = {
    projects:  new ProjectRepository(),   // table: project
    sessions:  new SessionRepository(),   // table: session
    batches:   new BatchRepository(),     // table: batch
    workflows: new WorkflowRepository(),  // table: workflow
    media:     new MediaRepository(),     // table: media
    configs:   new GenerationConfigRepository(), // tables: generation_config + generation_config_reference
    dna:        new DnaRepository(),       // table: dna
    characters: new CharacterRepository(), // Dedicated Character Domain Repository
};

// ─── Workflow Architecture (feature 008) ─────────────────────────────────────
export const workflowEventRecorder = new WorkflowEventRecorder();
export const workflowBillingGateway = new WorkflowBillingGateway({ walletService });
export const mediaWorkflowLifecycleService = new MediaWorkflowLifecycleService({ db });
export const workflowStorageGateway = new WorkflowStorageGateway({
    storageService,
    v1Db: db,
    lifecycleService: mediaWorkflowLifecycleService,
});
export const workflowQueueGateway = new WorkflowQueueGateway();
export const workflowExecutionRepository = new WorkflowExecutionRepository({ db });
export const workflowRunner = new WorkflowRunner({
    executionRepository: workflowExecutionRepository,
    eventRecorder: workflowEventRecorder,
    billingGateway: workflowBillingGateway,
    storageGateway: workflowStorageGateway,
    queueGateway: workflowQueueGateway,
    treatmentDeps: () => ({
        db,
        storageService,
        promptService,
        models: IMAGE_MODELS,
        dnaTreatment,
        walletService,
    }),
});
export const workflowStatusService = new WorkflowStatusService({
    executionRepository: workflowExecutionRepository,
});

// ─── DNA Treatment ────────────────────────────────────────────────────────────

export const dnaTreatment = new DnaTreatment({
    textProvider: promptService.textProvider,
    db
});

// ─── Provider Registry (V2 adapters registered in bootstrap.js) ─────────────
// Image and Video providers are registered by bootstrapV2() in v2/bootstrap.js.
// They route directly to model runners (WavespeedImageRunner, etc.).
// No V1 treatment runners are registered here.
