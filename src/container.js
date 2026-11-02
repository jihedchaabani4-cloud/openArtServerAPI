import "dotenv/config";
import { PromptService } from "#platform/ai/PromptService.js";
import { createStorageService } from "#platform/storage";
import { supabaseAdmin } from "#lib/supabase.js";
import {
    WalletService,
    PricingService,
    FailedOpsService,
    UsageEventRepository,
    configureBilling,
    createWalletService,
    createFailedOpsService,
} from "#platform/billing";
import { createClient } from "@supabase/supabase-js";
import { redisConnection } from "#queue/redis.js";
import { createLogger } from "./infrastructure/logging/index.js";

const systemLogger = createLogger("system");

// ─── Repositories ───────────────────────────────────────────────────────────
import { ProjectRepository }          from "#db/ProjectRepository.js";
import { WorkflowRepository }         from "#db/WorkflowRepository.js";
import { MediaRepository }            from "#db/MediaRepository.js";
import { WorkflowMediaRepository }     from "#db/WorkflowMediaRepository.js";
import { GenerationConfigRepository } from "#db/GenerationConfigRepository.js";
import { CharacterRepository }        from "#db/CharacterRepository.js";
import { ElementRepository }          from "#db/ElementRepository.js";
import { FolderRepository }           from "#db/FolderRepository.js";
import { TrashRepository }            from "#db/TrashRepository.js";

// ─── Infrastructure ───────────────────────────────────────────────────────────
import { WorkflowEventRecorder } from "./infrastructure/events/workflowEventRecorder.js";
import { WorkflowBillingGateway } from "./infrastructure/billing/workflowBillingGateway.js";
import { MediaService, MediaWorkflowLifecycleService } from "#platform/media/index.js";
import { WorkflowLifecycleService } from "#platform/workflow/WorkflowService.js";
import { MediaUploadService } from "#platform/media-ingestion/index.js";
import { CharacterService } from "#domain/character/CharacterService.js";
import { CharacterMediaService } from "#domain/character/CharacterMediaService.js";
import { ElementService } from "#domain/element/ElementService.js";
import { ElementMediaService } from "#domain/element/ElementMediaService.js";
import { ElementAnalysisService } from "#domain/element/ElementAnalysisService.js";
import { ProjectReadService } from "#domain/project/ProjectReadService.js";
import { ProjectService } from "#domain/project/ProjectService.js";
import { GenerationService } from "#domain/generation/GenerationService.js";
import { GenerationRequestService } from "#domain/generation/GenerationRequestService.js";
import { FolderService } from "./domain/folder/FolderService.js";
import { WorkflowStorageGateway } from "./infrastructure/storage/workflowStorageGateway.js";
import { AssetUploadService } from "./domain/asset/AssetUploadService.js";
import { TrashService } from "./domain/trash/TrashService.js";



// ─── Services ────────────────────────────────────────────────────────────────
export const promptService  = new PromptService();
export const storageService = createStorageService({ client: supabaseAdmin });
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
export function assertRateLimitConfiguredForEnvironment(logger = systemLogger) {
    const isProd = isProductionEnvironment();
    if (!isProd) return;

    const store = (process.env.RATE_LIMIT_STORE || "").trim().toLowerCase();
    const allowMemory = process.env.ALLOW_IN_MEMORY_RATE_LIMIT === "true";

    if (store === "redis") {
        return;
    }

    if (allowMemory) {
        logger.warn(
            { event: "security.rate_limit_memory_warning" },
            "CRITICAL SECURITY WARNING: RATE_LIMIT_STORE is running in 'memory' mode in production. Rate limits will NOT be shared across instances! Allowed only via ALLOW_IN_MEMORY_RATE_LIMIT=true."
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

const _supabaseForBilling = process.env.SUPABASE_URL && walletServiceKey
    ? createClient(process.env.SUPABASE_URL, walletServiceKey)
    : null;
export const usageEventRepo = _supabaseForBilling
    ? new UsageEventRepository(_supabaseForBilling)
    : null;

export const walletService  = _supabaseForBilling
    ? createWalletService({ client: _supabaseForBilling, usageEventRepo })
    : null;

if (walletService) {
    configureBilling({ walletService });
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
export const failedOpsService = _supabaseForBilling
    ? createFailedOpsService({ client: _supabaseForBilling })
    : null;

if (failedOpsService) {
    systemLogger.debug("FailedOpsService initialized");
} else {
    systemLogger.warn("FailedOpsService disabled: missing Supabase config");
}

// ─── DB (new 7-table schema) ─────────────────────────────────────────────────
export const db = {
    projects:  new ProjectRepository(),   // table: project
    workflows: new WorkflowRepository(),  // table: workflow
    media:     new MediaRepository(),     // table: media
    workflowMedia: new WorkflowMediaRepository(), // table: workflow_media
    configs:   new GenerationConfigRepository(), // tables: generation_config + generation_config_reference
    characters: new CharacterRepository(), // Dedicated Character Domain Repository
    elements:   new ElementRepository(),   // Dedicated Element Domain Repository
    folders:    new FolderRepository(),    // Dedicated Folders Domain Repository
    trash:      new TrashRepository(),     // Dedicated Workflow Trash Repository
};

// ─── Workflow Architecture (feature 008) ─────────────────────────────────────
export const workflowEventRecorder = new WorkflowEventRecorder();
export const workflowBillingGateway = new WorkflowBillingGateway({ walletService });

const _lifecycleService = new MediaWorkflowLifecycleService({ db });
export const mediaWorkflowLifecycleService = _lifecycleService;
export const workflowStorageGateway = new WorkflowStorageGateway({
    v1Db: db,
    lifecycleService: _lifecycleService,
});


// ─── UseCase & Job Queue Services ─────────────────────────────────────────────
import { UseCaseService } from "./services/useCaseService.js";
import { jobQueueService } from "./services/jobQueueService.js";
export { jobQueueService };
export const useCaseService = new UseCaseService({ walletService, pricingService, jobQueueService, db });

// ─── Domain & Platform Services ──────────────────────────────────────────────
export const mediaUploadService = new MediaUploadService({ storageService });

export const folderService = new FolderService({ folderRepo: db.folders, projectRepo: db.projects });
export const workflowService = new WorkflowLifecycleService({ db, storageService, folderService, mediaUploadService });
folderService.setWorkflowService(workflowService);
export const workflowMediaService = workflowService.mediaService;
export const mediaService = new MediaService({ db });

export const assetUploadService = new AssetUploadService({
    db,
    mediaUploadService,
    workflowMediaService,
    authService: workflowService.authService,
    mediaService,
    folderService,
});

export const characterMediaService = new CharacterMediaService({
    db,
    storageService,
    mediaUploadService,
    workflowMediaService,
    authService: workflowService.authService,
});

export const characterService = new CharacterService({
    db,
    workflowService,
    useCaseService,
    mediaService: characterMediaService,
});

export const elementMediaService = new ElementMediaService({
    db,
    storageService,
    mediaUploadService,
    workflowMediaService,
    authService: workflowService.authService,
});

export const elementService = new ElementService({
    db,
    workflowService,
    mediaService: elementMediaService,
    analysisService: new ElementAnalysisService(),
});

workflowService.setEntitySyncHandlers({
    syncCharacter: (targetWorkflowId, updates, userId) => characterService.updateCharacter({ characterId: targetWorkflowId, updates, userId }),
    syncElement: (targetWorkflowId, name) => elementService.updateElement(targetWorkflowId, { name }),
});

export const trashService = new TrashService({
    db,
    workflowService,
    elementService,
    characterService,
});

export const projectReadService = new ProjectReadService({ db });
export const projectService = new ProjectService({ projectRepo: db.projects });
export const generationService = new GenerationService({ db });
export const generationRequestService = new GenerationRequestService({ db, useCaseService, folderService });

