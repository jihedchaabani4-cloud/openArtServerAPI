import "dotenv/config";
import {
    WalletService,
    FailedOpsService,
    UsageEventRepository,
    configureBilling,
    createWalletService,
    createFailedOpsService,
    getUsageEventRepository,
    getCreditPackageRepository,
    getWalletRepository,
    getTransactionRepository,
} from "#billing/tools";
import { PricingService } from "#models/tools";
import { redisConnection, createLogger, envConfig } from "#shared";

const systemLogger = createLogger("system");

// ─── Repositories ───────────────────────────────────────────────────────────
import { ProjectRepository, FolderRepository, TrashRepository, ProjectService, ProjectReadService, FolderService, TrashService, configureWorkspace } from "#workspace/tools";
import {
    WorkflowRepository,
    GenerationConfigRepository,
    GenerationService,
    GenerationRequestService,
    WorkflowLifecycleService,
    PromptService,
    promptService,
    UseCaseService,
    jobQueueService,
    configureGeneration,
    configureDefaultGateways,
    WorkflowEventRecorder,
    WorkflowBillingGateway,
    WorkflowStorageGateway,
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

// ─── Workflow Architecture (feature 008) ─────────────────────────────────────
export const workflowEventRecorder = new WorkflowEventRecorder();
export const workflowBillingGateway = new WorkflowBillingGateway({ walletService });

const _lifecycleService = new MediaWorkflowLifecycleService({ db });
export const mediaWorkflowLifecycleService = _lifecycleService;
configureBilling({ lifecycleService: _lifecycleService });

export const workflowStorageGateway = new WorkflowStorageGateway({
    v1Db: db,
    lifecycleService: _lifecycleService,
});

const _defaultGatewaysFactory = () => ({
    billing: workflowBillingGateway,
    storage: workflowStorageGateway,
    events: workflowEventRecorder,
});
configureDefaultGateways(_defaultGatewaysFactory);

// ─── UseCase & Job Queue Services ─────────────────────────────────────────────
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

export const projectReadService = new ProjectReadService({ db, folderService });
export const projectService = new ProjectService({ projectRepo: db.projects });
export const generationService = new GenerationService({ db });
export const generationRequestService = new GenerationRequestService({ db, useCaseService, folderService });
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
    useCaseService,
    db,
});
