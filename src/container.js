import "dotenv/config";
import { PromptService } from "#platform/ai/PromptService.js";
import { StorageService } from "#platform/storage/StorageService.js";
import { VisionService } from "#platform/ai/VisionService.js";
import { WalletService } from "#platform/billing/WalletService.js";
import { PricingService } from "#platform/billing/PricingService.js";
import { FailedOpsService } from "#platform/billing/FailedOpsService.js";
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

// ─── DNA Domain ───────────────────────────────────────────────────────────────
import { DnaTreatment } from "./dna/DnaTreatment.js";
import { WorkflowEventRecorder } from "./infrastructure/events/workflowEventRecorder.js";
import { WorkflowBillingGateway } from "./infrastructure/billing/workflowBillingGateway.js";
import { MediaWorkflowLifecycleService } from "#platform/media/MediaLifecycleService.js";
import { WorkflowLifecycleService } from "#platform/workflow/WorkflowService.js";
import { CharacterService } from "#domain/character/CharacterService.js";
import { ProjectReadService } from "#domain/project/ProjectReadService.js";
import { GenerationService } from "#domain/generation/GenerationService.js";
import { AuthorizationService } from "#platform/security/AuthorizationService.js";
import { TenantAccessService } from "#platform/security/TenantAccessService.js";
import { AuditService } from "#platform/security/AuditService.js";
import { WorkflowStorageGateway } from "./infrastructure/storage/workflowStorageGateway.js";
import { WorkflowQueueGateway } from "./infrastructure/queue/workflowQueueGateway.js";

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

// ─── DNA Treatment ────────────────────────────────────────────────────────────

export const dnaTreatment = new DnaTreatment({
    textProvider: promptService.textProvider,
    db
});

// ─── Domain Services (feature 024-unify-domain-crud) ─────────────────────────
// WorkflowLifecycleService: canonical domain owner for all workflow & media CRUD
export const workflowService = new WorkflowLifecycleService({ db, storageService });

// CharacterService: owns character entity CRUD; delegates workflow cleanup to workflowService
export const characterService = new CharacterService({
    db,
    storageService,
    workflowService,
});

// ProjectReadService: owns unified project-data read aggregation
export const projectReadService = new ProjectReadService({ db });

// GenerationService: owns all generation read/mutation queries (feature 026)
export const generationService = new GenerationService({ db });

// ─── Platform Security Services (feature 026) ────────────────────────────────
export const authorizationService = new AuthorizationService();
export const tenantAccessService = new TenantAccessService({ db });
export const auditService = new AuditService();

// ─── UseCase & Job Queue Services (feature 028) ─────────────────────────────
import { UseCaseService } from "./services/useCaseService.js";
export { jobQueueService } from "./services/jobQueueService.js";
export const useCaseService = new UseCaseService({ walletService, pricingService });
