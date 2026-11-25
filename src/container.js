import "dotenv/config";
import {
    WalletService,
    FailedOpsService,
    configureBilling,
    createWalletService,
    createFailedOpsService,
    getUsageEventRepository,
    getCreditPackageRepository,
    getWalletRepository,
    getTransactionRepository,
} from "#billing/tools";
import { PricingService, promptService } from "#models/tools";
import { redisConnection, createLogger, envConfig } from "#shared";

const systemLogger = createLogger("system");

// ─── Repositories ───────────────────────────────────────────────────────────
import { ProjectRepository, FolderRepository, TrashRepository, ProjectService, ProjectReadService, FolderService, TrashService, configureWorkspace } from "#workspace/tools";
import {
    WorkflowRepository,
    GenerationConfigRepository,
    GenerationService,
    GenerationRequestService,
    WorkflowService,
    ExecutionEngine,
    jobQueueService,
    configureGeneration,
} from "#generation/tools";
import {
    MediaRepository,
    WorkflowMediaRepository,
    MediaService,
    MediaWorkflowLifecycleService,
    MediaUploadService,
    AssetUploadService,
    getStorageService,
    configureMedia,
    markMediaFailed,
} from "#media/tools";
import { CharacterRepository, CharacterService, CharacterMediaService, configureCharacters } from "#characters/tools";
import { ElementRepository, ElementService, ElementMediaService, ElementAnalysisService, configureElements } from "#elements/tools";
import { setDb as setIdentityDb } from "#identity/tools";

// ─── Services ────────────────────────────────────────────────────────────────
export { promptService };
export const storageService = getStorageService();
const walletServiceKey = envConfig.supabaseServiceRoleKey || null;

/**
 * Evaluates whether current runtime is in production mode.
 * Any environment other than explicit "development" or "test" is treated as production (fail-safe).
 */
export function isProductionEnvironment() {
    const rawEnv = envConfig.getEnvVar("NODE_ENV") || "";
    const env = rawEnv.trim().toLowerCase();
    return env !== "development" && env !== "test";
}

/**
 * Enforce that production environments must never boot without wallet configuration.
 */
export function assertWalletConfiguredForEnvironment() {
    const isProd = isProductionEnvironment();
    const hasUrl = Boolean(envConfig.rawSupabaseUrl);
    const key = envConfig.supabaseServiceRoleKey;
    const hasKey = Boolean(key);

    if (isProd && (!hasUrl || !hasKey)) {
        const missing = [!hasUrl ? "SUPABASE_URL" : null, !hasKey ? "SUPABASE_SERVICE_ROLE_KEY/SUPABASE_KEY" : null]
            .filter(Boolean)
            .join(", ");
        throw new Error(
            `Fatal: WalletService is required in production mode (NODE_ENV=${envConfig.getEnvVar("NODE_ENV") || "unset"}). Missing: ${missing}`
        );
    }
}

/**
 * Enforce that production environments must never boot without a strong INTERNAL_SECRET (>= 32 chars).
 */
export function assertSecurityConfiguredForEnvironment() {
    const isProd = isProductionEnvironment();
    const secret = envConfig.internalSecret;

    if (isProd) {
        if (!secret || typeof secret !== "string" || secret.trim().length < 32) {
            throw new Error(
                `Fatal: INTERNAL_SECRET is required in production mode (NODE_ENV=${envConfig.getEnvVar("NODE_ENV") || "unset"}) and must be at least 32 characters long.`
            );
        }
        const rawBypass = envConfig.getEnvVar("DEV_AUTH_BYPASS");
        if (rawBypass === "true" || rawBypass === true) {
            throw new Error(
                `Fatal: DEV_AUTH_BYPASS cannot be enabled in production mode (NODE_ENV=${envConfig.getEnvVar("NODE_ENV") || "unset"}).`
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

    const store = (envConfig.getEnvVar("RATE_LIMIT_STORE") || "").trim().toLowerCase();
    const allowMemory = envConfig.allowInMemoryRateLimit;

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
        `Fatal: RATE_LIMIT_STORE must be set to 'redis' in production mode (NODE_ENV=${envConfig.getEnvVar("NODE_ENV") || "unset"}), or set ALLOW_IN_MEMORY_RATE_LIMIT=true for single-instance staging.`
    );
}

assertWalletConfiguredForEnvironment();
assertSecurityConfiguredForEnvironment();
assertRateLimitConfiguredForEnvironment();

const _hasBillingConfig = Boolean(envConfig.rawSupabaseUrl && walletServiceKey);
export const usageEventRepo = _hasBillingConfig
    ? getUsageEventRepository()
    : null;
export const creditPackageRepo = _hasBillingConfig
    ? getCreditPackageRepository()
    : null;
export const billingRepos = _hasBillingConfig
    ? {
        walletRepo: getWalletRepository(),
        txRepo: getTransactionRepository(),
        transactionRepo: getTransactionRepository(),
        usageEventRepo,
        creditPackageRepo,
    }
    : null;

export const walletService = _hasBillingConfig
    ? createWalletService({ usageEventRepo })
    : null;

if (walletService) {
    configureBilling({ walletService, creditPackageRepo });
    systemLogger.debug("WalletService initialized");
} else {
    systemLogger.warn("WalletService disabled: missing SUPABASE_URL or service key");
}

// ─── Pricing Service (DB-backed + Redis cache) ────────────────────────────────
export const pricingService = _hasBillingConfig
    ? new PricingService({ redis: redisConnection })
    : null;

if (pricingService) {
    configureBilling({ pricingService, redisConnection });
    systemLogger.debug("PricingService initialized");
} else {
    configureBilling({ redisConnection });
    systemLogger.warn("PricingService disabled: missing Supabase config");
}

// ─── Failed Operations Service ────────────────────────────────────────────────
export const failedOpsService = _hasBillingConfig
    ? createFailedOpsService()
    : null;

if (failedOpsService) {
    systemLogger.debug("FailedOpsService initialized");
} else {
    systemLogger.warn("FailedOpsService disabled: missing Supabase config");
}

// ─── DB (new 7-table schema) ─────────────────────────────────────────────────
const configRepo = new GenerationConfigRepository();
export const db = {
    projects:          new ProjectRepository(),
    workflows:         new WorkflowRepository(),
    media:             new MediaRepository(),
    workflowMedia:     new WorkflowMediaRepository(),
    configs:           configRepo,
    generationConfigs: configRepo,
    characters:        new CharacterRepository(),
    elements:          new ElementRepository(),
    folders:           new FolderRepository(),
    trash:             new TrashRepository(),
};
setIdentityDb(db);

export const mediaWorkflowLifecycleService = new MediaWorkflowLifecycleService({ db });
configureBilling({ lifecycleService: mediaWorkflowLifecycleService });

// ─── V3 Execution Engine & Job Queue Services ──────────────────────────────────
export { jobQueueService };
export const executionEngine = new ExecutionEngine({
    jobQueueService,
});

// External Media domain hook: marks pending media rows failed when a media-backed run
// fails or crashes, keeping ExecutionEngine and useCaseWorker 100% decoupled from #media/tools.
executionEngine.onFailure(async ({ input, serverContext, errorCode, errorMessage }) => {
    const mediaIds = [...new Set([
        ...(Array.isArray(serverContext?.mediaIds) ? serverContext.mediaIds : []),
        ...(Array.isArray(input?.serverMediaIds) ? input.serverMediaIds : []),
        input?.media_id,
        input?.mediaId,
        input?.pendingMediaId,
        serverContext?.pendingMediaId,
    ].filter((id) => typeof id === "string" && id.trim()))];

    for (const mediaId of mediaIds) {
        await markMediaFailed({
            mediaId,
            errorCode: errorCode || "V3_EXECUTION_FAILED",
            errorMessage: errorMessage || "Generation failed. Please try again.",
        }).catch((mediaErr) => {
            systemLogger.warn(
                { mediaId, errorCode, err: mediaErr?.message },
                "[Container] External media failure hook encountered an error"
            );
        });
    }
});


// ─── Domain & Platform Services ──────────────────────────────────────────────
export const mediaUploadService = new MediaUploadService({ storageService });

export const folderService = new FolderService({
    folderRepo: db.folders,
    projectRepo: db.projects,
    trashRepo: db.trash,
    mediaRepo: db.media,
    workflowMediaRepo: db.workflowMedia,
});
export const workflowService = new WorkflowService({ db, storageService, folderService, mediaUploadService });
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
    executionEngine,
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
configureElements({ elementService, elementMediaService });

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
folderService.setPermanentDeleteWorkflow(({ workflowId, userId, req = null }) =>
    trashService.permanentlyDeleteByWorkflowOwner({ workflowId, userId, req })
);

export const projectReadService = new ProjectReadService({ db, folderService });
export const projectService = new ProjectService({ projectRepo: db.projects, mediaRepo: db.media });
export const generationService = new GenerationService({ db });
export const generationRequestService = new GenerationRequestService({ db, executionEngine, folderService });
configureCharacters({ characterService, characterMediaService, trashService });
configureMedia({ db, assetUploadService, workflowService, storageService, mediaUploadService, mediaService });
configureWorkspace({ trashService, projectService, folderService, projectReadService, generationService });
configureGeneration({
    generationService,
    generationRequestService,
    workflowService,
    projectReadService,
    characterService,
    elementService,
    trashService,
    executionEngine,
    db,
});
