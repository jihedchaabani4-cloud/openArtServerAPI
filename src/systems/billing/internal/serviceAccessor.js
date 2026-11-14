/**
 * System 3: Billing & Wallet — Internal Service Accessor
 */

import {
    BillingValidationError,
    BillingConfigurationError,
} from "./errors.js";

import {
    WalletRepository,
    TransactionRepository,
    CreditPackageRepository,
    FailedOpsRepository,
    UsageEventRepository,
    getBillingSupabaseClient,
    getBillingSupabaseAdminClient,
} from "./db/index.js";

import { WalletService } from "./services/WalletService.js";
import { FailedOpsService } from "./services/FailedOpsService.js";

let _defaultWalletService = null;
let _defaultCreditPackageRepo = null;
let _defaultPackageFetcher = null;
let _defaultFailedOpsService = null;
let _defaultWalletRepo = null;
let _defaultPricingService = null;
let _defaultRedisConnection = null;
let _defaultLifecycleService = null;

export function configureBilling(params = {}) {
    if ("walletService" in params) _defaultWalletService = params.walletService;
    if ("creditPackageRepo" in params) _defaultCreditPackageRepo = params.creditPackageRepo;
    if ("packageFetcher" in params) _defaultPackageFetcher = params.packageFetcher;
    if ("failedOpsService" in params) _defaultFailedOpsService = params.failedOpsService;
    if ("pricingService" in params) _defaultPricingService = params.pricingService;
    if ("redisConnection" in params) _defaultRedisConnection = params.redisConnection;
    if ("lifecycleService" in params) _defaultLifecycleService = params.lifecycleService;
}

export function getDefaultLifecycleService() {
    return _defaultLifecycleService;
}

export function getPricingService() {
    return _defaultPricingService;
}

export function getRedisConnection() {
    return _defaultRedisConnection;
}

export function getDefaultPackageFetcher() {
    return _defaultPackageFetcher;
}

export function getDefaultCreditPackageRepo() {
    return _defaultCreditPackageRepo;
}

export function getDefaultWalletService() {
    return _defaultWalletService;
}

export function getWalletService() {
    if (!_defaultWalletService) {
        const client = getBillingSupabaseAdminClient();
        _defaultWalletService = new WalletService({
            walletRepo: new WalletRepository(client),
            txRepo: new TransactionRepository(client),
            usageEventRepo: new UsageEventRepository(client),
            supabase: client,
        });
    }
    return _defaultWalletService;
}

export function getBillingService() {
    return _defaultWalletService || getWalletService();
}

export function getCreditPackageRepository() {
    if (!_defaultCreditPackageRepo) {
        const client = getBillingSupabaseClient();
        _defaultCreditPackageRepo = new CreditPackageRepository(client);
    }
    return _defaultCreditPackageRepo;
}

export function getFailedOpsService() {
    if (!_defaultFailedOpsService) {
        const client = getBillingSupabaseAdminClient();
        const repo = new FailedOpsRepository(client);
        _defaultFailedOpsService = new FailedOpsService({ failedOpsRepo: repo });
    }
    return _defaultFailedOpsService;
}

let _defaultTxRepo = null;
let _defaultUsageEventRepo = null;

export function getWalletRepository() {
    if (!_defaultWalletRepo) {
        const client = getBillingSupabaseAdminClient();
        _defaultWalletRepo = new WalletRepository(client);
    }
    return _defaultWalletRepo;
}

export function getTransactionRepository() {
    if (!_defaultTxRepo) {
        const client = getBillingSupabaseAdminClient();
        _defaultTxRepo = new TransactionRepository(client);
    }
    return _defaultTxRepo;
}

export function getUsageEventRepository() {
    if (!_defaultUsageEventRepo) {
        const client = getBillingSupabaseAdminClient();
        _defaultUsageEventRepo = new UsageEventRepository(client);
    }
    return _defaultUsageEventRepo;
}

export async function listCreditPackages(options = {}, ctx = {}) {
    if (typeof ctx?.packageFetcher === "function") {
        return ctx.packageFetcher(options);
    }
    if (typeof _defaultPackageFetcher === "function") {
        return _defaultPackageFetcher(options);
    }
    const repo = ctx?.creditPackageRepo || _defaultCreditPackageRepo || getCreditPackageRepository();
    if (repo && typeof repo.listActivePackages === "function") {
        return repo.listActivePackages();
    }
    return [];
}

export async function getCreditPackage(packageId, ctx = {}) {
    if (!packageId || typeof packageId !== "string") {
        throw new BillingValidationError("packageId is required");
    }
    const repo = ctx?.creditPackageRepo || _defaultCreditPackageRepo || getCreditPackageRepository();
    if (!repo) {
        throw new BillingConfigurationError("CreditPackageRepository is not configured in Billing system");
    }
    return repo.findActiveById(packageId);
}

export async function resolvePackageCredits(input = {}, ctx = {}) {
    const { variantId, packageId } = input || {};
    const repo = ctx?.creditPackageRepo || _defaultCreditPackageRepo || getCreditPackageRepository();
    if (!repo) {
        throw new BillingConfigurationError("CreditPackageRepository is not configured in Billing system");
    }

    if (variantId) {
        const credits = await repo.findCreditsByVariantId(variantId);
        if (credits != null) return credits;
    }

    if (packageId) {
        return repo.findCreditsById(packageId);
    }

    return null;
}
