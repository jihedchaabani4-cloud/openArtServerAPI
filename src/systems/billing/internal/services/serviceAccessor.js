/**
 * System 3: Billing & Wallet — Internal Service Accessor
 */

import {
    BillingValidationError,
    BillingConfigurationError,
} from "../errors.js";

import {
    createBillingRepositories,
    createDefaultBillingRepositories,
    createDefaultWalletRepository,
    createDefaultTransactionRepository,
    createDefaultUsageEventRepository,
    createDefaultCreditPackageRepository,
    createDefaultFailedOpsRepository,
} from "../db/billingRepositoryFactory.js";

import { WalletService } from "./WalletService.js";
import { FailedOpsService } from "./FailedOpsService.js";

export { createBillingRepositories };

let _defaultWalletService = null;
let _defaultCreditPackageRepo = null;
let _defaultPackageFetcher = null;
let _defaultFailedOpsService = null;
let _defaultWalletRepo = null;
let _defaultRedisConnection = null;
let _defaultLifecycleService = null;

export function configureBilling(params = {}) {
    if ("walletService" in params) _defaultWalletService = params.walletService;
    if ("creditPackageRepo" in params) _defaultCreditPackageRepo = params.creditPackageRepo;
    if ("packageFetcher" in params) _defaultPackageFetcher = params.packageFetcher;
    if ("failedOpsService" in params) _defaultFailedOpsService = params.failedOpsService;
    if ("redisConnection" in params) _defaultRedisConnection = params.redisConnection;
    if ("lifecycleService" in params) _defaultLifecycleService = params.lifecycleService;
}

export function getDefaultLifecycleService() {
    return _defaultLifecycleService;
}

export function getRedisConnection() {
    return _defaultRedisConnection;
}

export function getDefaultWalletService() {
    return _defaultWalletService;
}

export function getWalletService() {
    if (!_defaultWalletService) {
        const repos = createDefaultBillingRepositories();
        _defaultWalletService = new WalletService({
            walletRepo: repos?.walletRepo || null,
            txRepo: repos?.txRepo || null,
            usageEventRepo: repos?.usageEventRepo || null,
            supabase: repos?.walletRepo?.supabase || null,
        });
    }
    return _defaultWalletService;
}

export function getBillingService() {
    return _defaultWalletService || getWalletService();
}

export function getCreditPackageRepository() {
    if (!_defaultCreditPackageRepo) {
        _defaultCreditPackageRepo = createDefaultCreditPackageRepository();
    }
    return _defaultCreditPackageRepo;
}

export function getFailedOpsService() {
    if (!_defaultFailedOpsService) {
        const repo = createDefaultFailedOpsRepository();
        _defaultFailedOpsService = new FailedOpsService({ failedOpsRepo: repo });
    }
    return _defaultFailedOpsService;
}

let _defaultTxRepo = null;
let _defaultUsageEventRepo = null;

export function getWalletRepository() {
    if (!_defaultWalletRepo) {
        _defaultWalletRepo = createDefaultWalletRepository();
    }
    return _defaultWalletRepo;
}

export function getTransactionRepository() {
    if (!_defaultTxRepo) {
        _defaultTxRepo = createDefaultTransactionRepository();
    }
    return _defaultTxRepo;
}

export function getUsageEventRepository() {
    if (!_defaultUsageEventRepo) {
        _defaultUsageEventRepo = createDefaultUsageEventRepository();
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
