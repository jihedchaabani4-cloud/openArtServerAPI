/**
 * @owns Legacy re-export for FailedOpsService.
 * Canonical implementation lives in System 3: Billing & Wallet (#billing/tools).
 */

export {
    FailedOpsService,
    FailedOpsService as default,
    FAILED_OPS_BACKOFF_BASE_MS,
    FAILED_OPS_BACKOFF_MULTIPLIER,
    FAILED_OPS_DEFAULT_MAX_RETRIES,
} from "#billing/tools";
