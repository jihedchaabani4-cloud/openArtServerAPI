/**
 * @owns Legacy re-export for WalletService.
 * Canonical implementation lives in System 3: Billing & Wallet (#billing/tools).
 */

export {
    WalletService,
    WalletService as default,
    WalletError,
    BillingConfigurationError,
} from "#billing/tools";