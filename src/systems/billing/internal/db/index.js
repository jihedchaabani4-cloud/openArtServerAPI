/**
 * System 3: Billing & Wallet — Internal Database Layer Gateway (Rule 6, Rule 12)
 */

import { WalletRepository } from "./WalletRepository.js";
import { TransactionRepository } from "./TransactionRepository.js";
import { CreditPackageRepository } from "./CreditPackageRepository.js";
import { FailedOpsRepository } from "./FailedOpsRepository.js";
import { UsageEventRepository } from "./UsageEventRepository.js";
import {
    getBillingSupabaseClient,
    getBillingSupabaseAdminClient,
    supabase,
    supabaseAdmin,
} from "./billingClient.js";
import { BillingConfigurationError } from "../errors.js";

/**
 * Creates the complete set of private Billing repositories.
 * @param {import('@supabase/supabase-js').SupabaseClient} [supabaseClient]
 * @param {Object} [options]
 * @param {import('@supabase/supabase-js').SupabaseClient} [options.catalogClient]
 * @returns {object|null}
 */
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

export {
    WalletRepository,
    TransactionRepository,
    CreditPackageRepository,
    FailedOpsRepository,
    UsageEventRepository,
    getBillingSupabaseClient,
    getBillingSupabaseAdminClient,
    supabase,
    supabaseAdmin,
};

export default {
    WalletRepository,
    TransactionRepository,
    CreditPackageRepository,
    FailedOpsRepository,
    UsageEventRepository,
    createBillingRepositories,
    getBillingSupabaseClient,
    getBillingSupabaseAdminClient,
};
