export class AppError extends Error {
  constructor(code, message, {
    type = "OPERATIONAL",       // OPERATIONAL | PROGRAMMER
    category = "SERVER_FAULT",  // USER_FAULT | SERVER_FAULT | UPSTREAM_FAULT | BILLING_FAULT
    statusCode = 500,
    retryable = false,
    billingAction = "NONE",     // NONE | RELEASE | COMMIT | ROLLBACK
    context = {},
  } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.type = type;
    this.category = category;
    this.statusCode = statusCode;
    this.retryable = retryable;
    this.billingAction = billingAction;
    this.context = context;
    this.timestamp = new Date().toISOString();
    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class ProviderError extends AppError {}   // upstream AI provider failures
export class ValidationError extends AppError {} // bad input, NSFW, policy violations
export class BillingError extends AppError {}    // wallet/credits inconsistencies
export class SystemError extends AppError {}     // programmer errors / bugs
