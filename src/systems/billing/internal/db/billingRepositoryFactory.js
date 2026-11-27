/**
 * System 3: Billing & Wallet — Repository Factory (internal/db/)
 * Isolates all Supabase client instantiation strictly inside internal/db/ per Rule R12.
 */
import { WalletRepository } from "./WalletRepository.js";
import { TransactionRepository } from "./TransactionRepository.js";
import { CreditPackageRepository } from "./CreditPackageRepository.js";
import { FailedOpsRepository } from "./FailedOpsRepository.js";
import { UsageEventRepository } from "./UsageEventRepository.js";
import {
    getBillingSupabaseClient,
    getBillingSupabaseAdminClient,
} from "./billingClient.js";
import { BillingConfigurationError } from "../errors.js";

export function createBillingRepositories(supabaseClient, { catalogClient = null } = {}) {
    if (!supabaseClient) return null;
    if (!catalogClient) {
        throw new BillingConfigurationError("[BillingFactory] catalogClient is required for CreditPackageRepository");
    }
    const txRepo = new TransactionRepository(supabaseClient);

    return {
        walletRepo: new WalletRepository(supabaseClient),
        transactionRepo: txRepo,
        txRepo,
        failedOpsRepo: new FailedOpsRepository(supabaseClient),
        usageEventRepo: new UsageEventRepository(supabaseClient),
        creditPackageRepo: new CreditPackageRepository(catalogClient),
    };
}

export function createDefaultWalletRepository() {
    const adminClient = getBillingSupabaseAdminClient();
    return adminClient ? new WalletRepository(adminClient) : null;
}

export function createDefaultTransactionRepository() {
    const adminClient = getBillingSupabaseAdminClient();
    return adminClient ? new TransactionRepository(adminClient) : null;
}

export function createDefaultUsageEventRepository() {
    const adminClient = getBillingSupabaseAdminClient();
    return adminClient ? new UsageEventRepository(adminClient) : null;
}

export function createDefaultCreditPackageRepository() {
    const catalogClient = getBillingSupabaseClient();
    return catalogClient ? new CreditPackageRepository(catalogClient) : null;
}

export function createDefaultFailedOpsRepository() {
    const adminClient = getBillingSupabaseAdminClient();
    return adminClient ? new FailedOpsRepository(adminClient) : null;
}

export function createDefaultBillingRepositories(options = {}) {
    const adminClient = options.supabase || options.client || getBillingSupabaseAdminClient();
    const catalogClient = options.catalogClient || getBillingSupabaseClient();
    if (!adminClient) return null;

    const txRepo = options.transactionRepo || options.txRepo || new TransactionRepository(adminClient);
    return {
        walletRepo: options.walletRepo || new WalletRepository(adminClient),
        transactionRepo: txRepo,
        txRepo,
        failedOpsRepo: options.failedOpsRepo || new FailedOpsRepository(adminClient),
        usageEventRepo: options.usageEventRepo || new UsageEventRepository(adminClient),
        creditPackageRepo: options.creditPackageRepo || (catalogClient ? new CreditPackageRepository(catalogClient) : null),
    };
}
