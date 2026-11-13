/**
 * Legacy Re-export for AppError.
 * Canonical implementation now lives in src/shared/errors/
 */
export {
  AppError,
  AppError as default,
  ProviderError,
  ValidationError,
  BillingError,
  SystemError,
  InsufficientCreditsError,
  ReservationExpiredError,
} from "../shared/errors/index.js";
