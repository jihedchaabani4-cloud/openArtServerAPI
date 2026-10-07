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
import { ElementRepository }          from "#db/ElementRepository.js";

// ─── Infrastructure ───────────────────────────────────────────────────────────
import { WorkflowEventRecorder } from "./infrastructure/events/workflowEventRecorder.js";
import { WorkflowBillingGateway } from "./infrastructure/billing/workflowBillingGateway.js";
import { MediaWorkflowLifecycleService } from "#platform/media/MediaLifecycleService.js";
import { WorkflowLifecycleService } from "#platform/workflow/WorkflowService.js";
import { MediaService } from "#platform/media/MediaService.js";
import { MediaIngestionService } from "#platform/media-ingestion/MediaIngestionService.js";
import { CharacterService } from "#domain/character/CharacterService.js";
import { ElementService } from "#domain/element/ElementService.js";
import { ElementMediaService } from "#domain/element/ElementMediaService.js";
import { ElementAnalysisService } from "#domain/element/ElementAnalysisService.js";
import { ProjectReadService } from "#domain/project/ProjectReadService.js";
import { GenerationService } from "#domain/generation/GenerationService.js";
import { WorkflowStorageGateway } from "./infrastructure/storage/workflowStorageGateway.js";

import { UsageEventRepository } from "#platform/billing/UsageEventRepository.js";

// ─── Services ────────────────────────────────────────────────────────────────
export const promptService  = new PromptService();
export const storageService = new StorageService();
const walletServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || null;

/**
 * Evaluates whether current runtime is in production mode.
 * Any environment other than explicit "development" or "test" is treated as production (fail-safe).
 */
export function isProductionEnvironment() {
    const env = (process.env.NODE_ENV || "").trim().toLowerCase();
    return env !== "development" && env !== "test";
}

/**
 * Enforce that production environments must never boot without wallet configuration.
 */
export function assertWalletConfiguredForEnvironment() {
    const isProd = isProductionEnvironment();
    const hasUrl = Boolean(process.env.SUPABASE_URL);
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
    const hasKey = Boolean(key);

    if (isProd && (!hasUrl || !hasKey)) {
        const missing = [!hasUrl ? "SUPABASE_URL" : null, !hasKey ? "SUPABASE_SERVICE_ROLE_KEY/SUPABASE_KEY" : null]
            .filter(Boolean)
            .join(", ");
        throw new Error(
            `Fatal: WalletService is required in production mode (NODE_ENV=${process.env.NODE_ENV || "unset"}). Missing: ${missing}`
        );
    }
}

/**
 * Enforce that production environments must never boot without a strong INTERNAL_SECRET (>= 32 chars).
 */
export function assertSecurityConfiguredForEnvironment() {
    const isProd = isProductionEnvironment();
    const secret = process.env.INTERNAL_SECRET;

    if (isProd) {
        if (!secret || typeof secret !== "string" || secret.trim().length < 32) {
            throw new Error(
                `Fatal: INTERNAL_SECRET is required in production mode (NODE_ENV=${process.env.NODE_ENV || "unset"}) and must be at least 32 characters long.`
            );
        }
        if (process.env.DEV_AUTH_BYPASS === "true" || process.env.DEV_AUTH_BYPASS === true) {
            throw new Error(
                `Fatal: DEV_AUTH_BYPASS cannot be enabled in production mode (NODE_ENV=${process.env.NODE_ENV || "unset"}).`
            );
        }
    }
}

/**
 * Enforce that production environments must use Redis for rate limiting,
 * unless explicitly exempted for single-instance staging via ALLOW_IN_MEMORY_RATE_LIMIT=true.
 */
export function assertRateLimitConfiguredForEnvironment() {
    const isProd = isProductionEnvironment();
    if (!isProd) return;

    const store = (process.env.RATE_LIMIT_STORE || "").trim().toLowerCase();
    const allowMemory = process.env.ALLOW_IN_MEMORY_RATE_LIMIT === "true";

    if (store === "redis") {
        return;
    }

    if (allowMemory) {
        systemLogger.warn(
            { event: "security.rate_limit_memory_warning" },
            "CRITICAL SECURITY WARNING: RATE_LIMIT_STORE is running in 'memory' mode in production. Rate limits will NOT be shared across instances! Allowed only via ALLOW_IN_MEMORY_RATE_LIMIT=true."
        );
        console.warn(
            "⚠️ CRITICAL SECURITY WARNING: RATE_LIMIT_STORE is running in 'memory' mode in production. Rate limits will NOT be shared across instances! Allowed only via ALLOW_IN_MEMORY_RATE_LIMIT=true."
        );
        return;
    }

    throw new Error(
        `Fatal: RATE_LIMIT_STORE must be set to 'redis' in production mode (NODE_ENV=${process.env.NODE_ENV || "unset"}), or set ALLOW_IN_MEMORY_RATE_LIMIT=true for single-instance staging.`
    );
}

assertWalletConfiguredForEnvironment();
assertSecurityConfiguredForEnvironment();
assertRateLimitConfiguredForEnvironment();

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
    elements:   new ElementRepository(),   // Dedicated Element Domain Repository
};

// ─── Workflow Architecture (feature 008) ─────────────────────────────────────
export const workflowEventRecorder = new WorkflowEventRecorder();
export const workflowBillingGateway = new WorkflowBillingGateway({ walletService });

const _lifecycleService = new MediaWorkflowLifecycleService({ db });
export const mediaWorkflowLifecycleService = _lifecycleService;
export const workflowStorageGateway = new WorkflowStorageGateway({
    storageService,
    v1Db: db,
    lifecycleService: _lifecycleService,
});


// ─── UseCase & Job Queue Services ─────────────────────────────────────────────
import { UseCaseService } from "./services/useCaseService.js";
import { jobQueueService } from "./services/jobQueueService.js";
export { jobQueueService };
export const useCaseService = new UseCaseService({ walletService, pricingService, jobQueueService, db });

// ─── Domain & Platform Services ──────────────────────────────────────────────
export const workflowService = new WorkflowLifecycleService({ db, storageService });
export const workflowMediaService = workflowService.mediaService;
export const mediaService = new MediaService({ db });

export const mediaIngestionService = new MediaIngestionService({
    db,
    storageService,
    workflowAuthService: workflowService.authService,
    mediaService,
});

export const characterService = new CharacterService({
    db,
    storageService,
    workflowService,
    useCaseService,
    mediaIngestionService,
});

export const elementMediaService = new ElementMediaService({
    db,
    storageService,
    mediaIngestionService,
    workflowService,
});

export const elementService = new ElementService({
    db,
    storageService,
    workflowService,
    mediaIngestionService,
    mediaService: elementMediaService,
    analysisService: new ElementAnalysisService(),
});

export const projectReadService = new ProjectReadService({ db });
export const generationService = new GenerationService({ db });

