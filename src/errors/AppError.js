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

export class InsufficientCreditsError extends BillingError {
  constructor(required, available) {
    super("INSUFFICIENT_CREDITS", `Insufficient credits: required ${required}, available ${available}`, {
      type: "OPERATIONAL",
      category: "BILLING_FAULT",
      statusCode: 402,
      retryable: false,
      billingAction: "NONE",
      context: { required, available },
    });
    this.required = required;
    this.available = available;
    this.safeMessage = "Insufficient credits for this generation";
  }
}

export class ReservationExpiredError extends BillingError {
  constructor(reservationId) {
    super("RESERVATION_EXPIRED", `Reservation '${reservationId}' has expired or was already released`, {
      type: "OPERATIONAL",
      category: "BILLING_FAULT",
      statusCode: 409,
      retryable: false,
      billingAction: "NONE",
      context: { reservationId },
    });
    this.reservationId = reservationId;
    this.safeMessage = "Credit reservation expired";
  }
}

