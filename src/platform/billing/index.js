/**
 * Billing Business System Legacy Entry Point (Rule 3)
 *
 * Canonical implementation now lives in System 3: Billing & Wallet (#billing/tools).
 */

export {
    // Services
    WalletService,
    FailedOpsService,
    reconcileExpiredHolds,
    handleExpireStaleHolds,

    // Repositories & Factories
    WalletRepository,
    TransactionRepository,
    CreditPackageRepository,
    FailedOpsRepository,
    UsageEventRepository,
    createBillingRepositories,
    createWalletService,
    createFailedOpsService,

    // Singletons & Configuration
    configureBilling,
    getBillingService,
    getWalletService,
    getCreditPackageRepository,
    getFailedOpsService,
    getWalletRepository,

    // DTO Tools
    getCreditBalance,
    reserveCredits,
    settleCredits,
    rollbackCredits,
    addCredits,
    listTransactions,
    listCreditPackages,
    getCreditPackage,
    resolvePackageCredits,

    // Typed Errors
    BillingError,
    BillingValidationError,
    BillingNotFoundError,
    BillingInsufficientFundsError,
    BillingConflictError,
    BillingConfigurationError,
    WalletError,
} from "#billing/tools";

import billingTools from "#billing/tools";
export default billingTools;
