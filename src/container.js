import "dotenv/config";
import { PromptService } from "#platform/ai/PromptService.js";
import { StorageService } from "#platform/storage/StorageService.js";
import { WalletService } from "#platform/billing/WalletService.js";
import { PricingService } from "#platform/billing/PricingService.js";
import { FailedOpsService } from "#platform/billing/FailedOpsService.js";
import { createClient } from "@supabase/supabase-js";
import { redisConnection } from "#queue/redis.js";
import { createLogger } from "./infrastructure/logging/index.js";

const systemLogger = createLogger("system");

// ─── Repositories ───────────────────────────────────────────────────────────
import { ProjectRepository }          from "#db/ProjectRepository.js";
import { SessionRepository }          from "#db/SessionRepository.js";
import { BatchRepository }            from "#db/BatchRepository.js";
import { WorkflowRepository }         from "#db/WorkflowRepository.js";
import { MediaRepository }            from "#db/MediaRepository.js";
import { GenerationConfigRepository } from "#db/GenerationConfigRepository.js";
import { DnaRepository }              from "#db/DnaRepository.js";
import { CharacterRepository }        from "#db/CharacterRepository.js";

// ─── Infrastructure ───────────────────────────────────────────────────────────
import { WorkflowEventRecorder } from "./infrastructure/events/workflowEventRecorder.js";
import { WorkflowBillingGateway } from "./infrastructure/billing/workflowBillingGateway.js";
import { MediaWorkflowLifecycleService } from "#platform/media/MediaLifecycleService.js";
import { WorkflowLifecycleService } from "#platform/workflow/WorkflowService.js";
import { CharacterService } from "#domain/character/CharacterService.js";
import { ProjectReadService } from "#domain/project/ProjectReadService.js";
import { GenerationService } from "#domain/generation/GenerationService.js";
import { WorkflowStorageGateway } from "./infrastructure/storage/workflowStorageGateway.js";

import { UsageEventRepository } from "#platform/billing/UsageEventRepository.js";

// ─── Services ────────────────────────────────────────────────────────────────
export const promptService  = new PromptService();
export const storageService = new StorageService();
const walletServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || null;

const _supabaseForUsageEvents = process.env.SUPABASE_URL && walletServiceKey
    ? createClient(process.env.SUPABASE_URL, walletServiceKey)
    : null;
export const usageEventRepo = _supabaseForUsageEvents
    ? new UsageEventRepository(_supabaseForUsageEvents)
    : null;

export const walletService  = process.env.SUPABASE_URL && walletServiceKey
    ? new WalletService(process.env.SUPABASE_URL, walletServiceKey, { usageEventRepo })
    : null;

if (walletService) {
    systemLogger.debug("WalletService initialized");
} else {
    systemLogger.warn("WalletService disabled: missing SUPABASE_URL or service key");
}

// ─── Pricing Service (DB-backed + Redis cache) ────────────────────────────────
const _supabaseForPricing = process.env.SUPABASE_URL && walletServiceKey
    ? createClient(process.env.SUPABASE_URL, walletServiceKey)
    : null;
export const pricingService = _supabaseForPricing
    ? new PricingService(_supabaseForPricing, redisConnection)
    : null;

if (pricingService) {
    systemLogger.debug("PricingService initialized");
} else {
    systemLogger.warn("PricingService disabled: missing Supabase config");
}

// ─── Failed Operations Service ────────────────────────────────────────────────
export const failedOpsService = process.env.SUPABASE_URL && walletServiceKey
    ? new FailedOpsService(process.env.SUPABASE_URL, walletServiceKey)
    : null;

if (failedOpsService) {
    systemLogger.debug("FailedOpsService initialized");
} else {
    systemLogger.warn("FailedOpsService disabled: missing Supabase config");
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

const _lifecycleService = new MediaWorkflowLifecycleService({ db });
export const workflowStorageGateway = new WorkflowStorageGateway({
    storageService,
    v1Db: db,
    lifecycleService: _lifecycleService,
});

// ─── Domain Services ──────────────────────────────────────────────────────────
export const workflowService = new WorkflowLifecycleService({ db, storageService });

export const characterService = new CharacterService({
    db,
    storageService,
    workflowService,
});

export const projectReadService = new ProjectReadService({ db });
export const generationService = new GenerationService({ db });

// ─── UseCase & Job Queue Services ─────────────────────────────────────────────
import { UseCaseService } from "./services/useCaseService.js";
import { jobQueueService } from "./services/jobQueueService.js";
export { jobQueueService };
export const useCaseService = new UseCaseService({ walletService, pricingService, jobQueueService });
