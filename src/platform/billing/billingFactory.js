/**
 * @owns Factory for Billing repositories and services with fail-closed dependency injection.
 */
import { WalletRepository } from "./repositories/WalletRepository.js";
import { TransactionRepository } from "./repositories/TransactionRepository.js";
import { FailedOpsRepository } from "./repositories/FailedOpsRepository.js";
import { UsageEventRepository } from "./UsageEventRepository.js";
import { WalletService } from "./WalletService.js";
import { FailedOpsService } from "./FailedOpsService.js";

/**
 * Creates the complete set of private Billing repositories.
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseClient
 * @returns {object|null}
 */
export function createBillingRepositories(supabaseClient) {
    if (!supabaseClient) return null;
    return {
        walletRepo: new WalletRepository(supabaseClient),
        transactionRepo: new TransactionRepository(supabaseClient),
        failedOpsRepo: new FailedOpsRepository(supabaseClient),
        usageEventRepo: new UsageEventRepository(supabaseClient),
    };
}

/**
 * Creates a WalletService instance with constructor-injected repositories.
 * @param {Object} [params]
 * @param {import('@supabase/supabase-js').SupabaseClient} [params.client]
 * @param {WalletRepository} [params.walletRepo]
 * @param {TransactionRepository} [params.transactionRepo]
 * @param {UsageEventRepository} [params.usageEventRepo]
 * @param {number} [params.defaultInitialBalance]
 * @returns {WalletService}
 */
export function createWalletService({
    client = null,
    walletRepo = null,
    transactionRepo = null,
    usageEventRepo = null,
    defaultInitialBalance = undefined,
} = {}) {
    const activeWalletRepo = walletRepo || (client ? new WalletRepository(client) : null);
    const activeTxRepo = transactionRepo || (client ? new TransactionRepository(client) : null);
    const activeUsageRepo = usageEventRepo || (client ? new UsageEventRepository(client) : null);

    return new WalletService({
        walletRepo: activeWalletRepo,
        txRepo: activeTxRepo,
        usageEventRepo: activeUsageRepo,
        defaultInitialBalance,
        supabase: client,
    });
}

/**
 * Creates a FailedOpsService instance with constructor-injected repository.
 * @param {Object} [params]
 * @param {import('@supabase/supabase-js').SupabaseClient} [params.client]
 * @param {FailedOpsRepository} [params.failedOpsRepo]
 * @returns {FailedOpsService}
 */
export function createFailedOpsService({ client = null, failedOpsRepo = null } = {}) {
    const activeRepo = failedOpsRepo || (client ? new FailedOpsRepository(client) : null);
    return new FailedOpsService({ failedOpsRepo: activeRepo });
}
