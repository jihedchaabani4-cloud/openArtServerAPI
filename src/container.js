import "dotenv/config";
import {
    configureBilling,
    createWalletService,
    createFailedOpsService,
    getCreditBalance,
} from "#billing/tools";
import { createLogger, envConfig } from "#shared";
import { redisConnection } from "#shared/redis";

const systemLogger = createLogger("system");

// ─── Repositories ───────────────────────────────────────────────────────────
import { ProjectRepository, FolderRepository, TrashRepository, ProjectService, ProjectReadService, FolderService, TrashService, configureWorkspace } from "#workspace/tools";
import {
    WorkflowRepository,
    GenerationService,
    GenerationRequestService,
    WorkflowService,
    WorkflowDispatchService,
    configureGeneration,
} from "#generation/tools";
import { configureWorkflowAdapters } from "#workflow-engine/tools";
import {
    MediaRepository,
    WorkflowMediaRepository,
    MediaService,
    MediaWorkflowLifecycleService,
    MediaUploadService,
    AssetUploadService,
    getStorageService,
    configureMedia,
    getMediaById,
    getMediaUrls,
    getWorkflowPrimaryMedia,
    completeMedia,
    persistExternalMedia,
    markMediaFailed,
} from "#media/tools";
import {
    CharacterRepository,
    CharacterService,
    CharacterMediaService,
    getCharacterPromptContext,
    configureCharacters,
} from "#characters/tools";
import {
    ElementRepository,
    ElementService,
    ElementMediaService,
    ElementAnalysisService,
    getElementPromptContext,
    configureElements,
} from "#elements/tools";
import {
    configureOwnershipResolvers,
    configureIdentityHooks,
    assertOwns,
    assertOwnsAny,
} from "#identity/tools";

// ─── Services ────────────────────────────────────────────────────────────────
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
export const walletService = _hasBillingConfig
    ? createWalletService()
    : null;

if (walletService) {
    configureBilling({ walletService });
    systemLogger.debug("WalletService initialized");
} else {
    systemLogger.warn("WalletService disabled: missing SUPABASE_URL or service key");
}

configureBilling({ redisConnection });

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
export const db = {
    projects:      new ProjectRepository(),
    workflows:     new WorkflowRepository(),
    media:         new MediaRepository(),
    workflowMedia: new WorkflowMediaRepository(),
    characters:    new CharacterRepository(),
    elements:      new ElementRepository(),
    folders:       new FolderRepository(),
    trash:         new TrashRepository(),
};
/**
 * Builds the inverted per-resource-type ownership resolvers wired at the composition root.
 * Keeps System 5 (Identity) completely decoupled from foreign repositories and table schemas.
 */
export function createOwnershipResolvers(targetDb) {
    const getDb = () => targetDb || {};

    return {
        async project(id, userId) {
            const d = getDb();
            if (d.projects?.findByUser) {
                const matches = await d.projects.findByUser(userId, id);
                return matches?.[0] || null;
            }
            if (d.projects?.findById) {
                const record = await d.projects.findById(id);
                if (record && record.user_id === userId) return record;
            }
            return null;
        },

        async character(id, userId) {
            const d = getDb();
            let charRecord = null;
            if (d.characters?.findByCharacterId) {
                charRecord = await d.characters.findByCharacterId(id).catch(() => null);
            }
            if (!charRecord && d.characters?.findById) {
                charRecord = await d.characters.findById(id).catch(() => null);
            }

            if (charRecord) {
                if (charRecord.user_id && charRecord.user_id === userId) return charRecord;

                const projectId = charRecord.project_id;
                if (projectId && d.projects?.findByUser) {
                    const matches = await d.projects.findByUser(userId, projectId).catch(() => []);
                    if (matches?.length) return charRecord;
                }

                const wfId = charRecord.workflow_id || id;
                if (d.workflows?.getWorkflow) {
                    const wf = await d.workflows.getWorkflow(wfId).catch(() => null);
                    if (wf?.project_id && d.projects?.findByUser) {
                        const matches = await d.projects.findByUser(userId, wf.project_id).catch(() => []);
                        if (matches?.length) return charRecord;
                    }
                }
            } else if (d.workflows?.getWorkflow) {
                const wf = await d.workflows.getWorkflow(id).catch(() => null);
                if (wf?.project_id && d.projects?.findByUser) {
                    const matches = await d.projects.findByUser(userId, wf.project_id).catch(() => []);
                    if (matches?.length) return wf;
                }
            }
            return null;
        },

        async element(id, userId) {
            const d = getDb();
            let elemRecord = null;
            if (d.elements?.resolveRecord) {
                elemRecord = await d.elements.resolveRecord(id).catch(() => null);
            } else if (d.elements?.findById) {
                elemRecord = await d.elements.findById(id).catch(() => null);
            }

            if (elemRecord) {
                if (elemRecord.user_id && elemRecord.user_id === userId) return elemRecord;

                const wfId = elemRecord.workflow_id || id;
                let wf = null;
                if (wfId && d.workflows?.getWorkflow) {
                    wf = await d.workflows.getWorkflow(wfId).catch(() => null);
                }
                if (!wf && wfId && d.workflows?.findById) {
                    wf = await d.workflows.findById(wfId).catch(() => null);
                }

                if (wf) {
                    if (wf.user_id && wf.user_id === userId) return elemRecord;
                    if (wf.project_id && d.projects?.findByUser) {
                        const matches = await d.projects.findByUser(userId, wf.project_id).catch(() => []);
                        if (matches?.length) return elemRecord;
                    }
                }
            }
            return null;
        },

        async workflow(id, userId) {
            const d = getDb();
            let wfRecord = null;
            if (d.workflows?.findById) {
                wfRecord = await d.workflows.findById(id).catch(() => null);
            }
            if (!wfRecord && d.workflows?.getWorkflow) {
                wfRecord = await d.workflows.getWorkflow(id).catch(() => null);
            }
            if (!wfRecord && d.workflowMedia?.findByMedia && d.workflows?.findById) {
                const links = await d.workflowMedia.findByMedia(id).catch(() => []);
                const linkedWfId = links?.[0]?.workflow_id;
                if (linkedWfId) {
                    wfRecord = await d.workflows.findById(linkedWfId).catch(() => null);
                }
            }

            if (wfRecord) {
                if (wfRecord.user_id && wfRecord.user_id === userId) return wfRecord;
                if (wfRecord.project_id && d.projects?.findByUser) {
                    const matches = await d.projects.findByUser(userId, wfRecord.project_id).catch(() => []);
                    if (matches?.length) return wfRecord;
                }
            }
            return null;
        },

        async media(id, userId) {
            const d = getDb();
            let mediaRecord = null;
            if (d.media?.findMediaByIdOrWorkflow) {
                mediaRecord = await d.media.findMediaByIdOrWorkflow(id).catch(() => null);
            }
            if (!mediaRecord && d.media?.findById) {
                mediaRecord = await d.media.findById(id).catch(() => null);
            }

            if (mediaRecord) {
                if (mediaRecord.user_id && mediaRecord.user_id === userId) return mediaRecord;
                if (mediaRecord.project_id && d.projects?.findByUser) {
                    const matches = await d.projects.findByUser(userId, mediaRecord.project_id).catch(() => []);
                    if (matches?.length) return mediaRecord;
                }
                if (d.workflowMedia?.findByMedia && d.workflows?.findById) {
                    const links = await d.workflowMedia.findByMedia(mediaRecord.id || id).catch(() => []);
                    const linkedWfId = links?.[0]?.workflow_id;
                    if (linkedWfId) {
                        const parentWf = await d.workflows.findById(linkedWfId).catch(() => null);
                        if (parentWf?.project_id && d.projects?.findByUser) {
                            const matches = await d.projects.findByUser(userId, parentWf.project_id).catch(() => []);
                            if (matches?.length) return mediaRecord;
                        }
                    }
                }
            }
            return null;
        },

        async collection_item(id, userId, { assertOwns }) {
            const d = getDb();
            let item = null;
            if (d.collection_items?.findById) {
                item = await d.collection_items.findById(id).catch(() => null);
            } else if (d.collection_items?.findByIdAndUser) {
                item = await d.collection_items.findByIdAndUser(id, userId).catch(() => null);
            }

            if (item) {
                if (item.user_id && item.user_id === userId) return item;

                const projectId = item.project_id;
                if (projectId && d.projects?.findByUser) {
                    const matches = await d.projects.findByUser(userId, projectId).catch(() => []);
                    if (matches?.length) return item;
                }

                if (item.media?.project?.user_id && item.media.project.user_id === userId) {
                    return item;
                }

                if (item.media_id) {
                    try {
                        const ownedMedia = await assertOwns("media", item.media_id, userId);
                        if (ownedMedia) return item;
                    } catch {
                        // Fail closed
                    }
                }
            }
            return null;
        },

        async folder(id, userId) {
            const d = getDb();
            if (d.folders?.findOwned) {
                const folder = await d.folders.findOwned(id, userId).catch(() => null);
                if (folder) {
                    if (folder.project_id && d.projects?.findByUser) {
                        const matches = await d.projects.findByUser(userId, folder.project_id).catch(() => []);
                        if (matches?.length) return folder;
                    } else {
                        return folder;
                    }
                }
            }
            return null;
        },
    };
}

configureOwnershipResolvers(createOwnershipResolvers(db));
configureIdentityHooks({
    ensureWallet: (userId) => walletService?.ensureWallet?.(userId),
    getCreditBalance,
});

export const mediaWorkflowLifecycleService = new MediaWorkflowLifecycleService({ db });
configureBilling({ lifecycleService: mediaWorkflowLifecycleService });

// ─── Standalone Workflow Engine Adapters & Generation Dispatcher ─────────────
export const workflowAdapters = Object.freeze({
    getCharacterPromptContext,
    getElementPromptContext,
    getMediaById,
    getMediaUrls,
    getWorkflowPrimaryMedia,
    completeMedia,
    persistExternalMedia,
    assertOwns,
    assertOwnsAny,
});
configureWorkflowAdapters(workflowAdapters);

export const workflowDispatcher = new WorkflowDispatchService();


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
    workflowDispatcher,
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
    analysisService: new ElementAnalysisService({
        workflowSync: {
            findWorkflow: async (id) => db.workflows.getWorkflow(id).catch(() => null),
            updateWorkflow: async (id, patch) => db.workflows.updateById(id, patch),
        },
    }),
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
export const generationRequestService = new GenerationRequestService({ db, workflowDispatcher, folderService });
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
    workflowDispatcher,
    markMediaFailed,
    workflowAdapters,
    db,
});
