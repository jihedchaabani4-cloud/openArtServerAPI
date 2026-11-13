/**
 * Base Application Error Hierarchy for apiOpenArt.
 *
 * Supports dual invocation signatures for seamless backward compatibility:
 *   1. Modern 3-arg: new AppError(code, message, { statusCode, type, category, retryable, billingAction, context })
 *   2. Legacy 2-arg: new AppError(message, statusCode)
 */

export class AppError extends Error {
  constructor(arg1, arg2, arg3 = {}) {
    let code = "APP_ERROR";
    let message = "";
    let options = {};

    if (typeof arg2 === "number") {
      // Legacy 2-arg signature: new AppError(message, statusCode)
      message = typeof arg1 === "string" ? arg1 : String(arg1 || "");
      options = {
        statusCode: arg2,
        type: "OPERATIONAL",
        category: arg2 >= 500 ? "SERVER_FAULT" : "USER_FAULT",
        ...(typeof arg3 === "object" && arg3 !== null ? arg3 : {}),
      };
      code = options.code || (arg2 === 404 ? "NOT_FOUND" : (arg2 === 401 ? "UNAUTHORIZED" : (arg2 === 403 ? "FORBIDDEN" : "APP_ERROR")));
    } else {
      // Modern 3-arg signature: new AppError(code, message, options)
      code = typeof arg1 === "string" ? arg1 : "APP_ERROR";
      message = typeof arg2 === "string" ? arg2 : String(arg2 || "");
      options = typeof arg3 === "object" && arg3 !== null ? arg3 : {};
    }

    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = options.statusCode ?? 500;
    this.type = options.type ?? "OPERATIONAL";
    this.category = options.category ?? (this.statusCode >= 500 ? "SERVER_FAULT" : "USER_FAULT");
    this.retryable = Boolean(options.retryable ?? false);
    this.billingAction = options.billingAction ?? "NONE";
    this.context = options.context ?? {};
    this.timestamp = new Date().toISOString();

    // Legacy fields expected by Express middleware & boundary tests
    this.status = `${this.statusCode}`.startsWith("4") ? "fail" : "error";
    this.isOperational = this.type === "OPERATIONAL";

    Error.captureStackTrace?.(this, this.constructor);
  }
}

export class ProviderError extends AppError {
  constructor(codeOrMessage, messageOrStatus, options) {
    if (typeof messageOrStatus === "number") {
      super(codeOrMessage, messageOrStatus, { category: "UPSTREAM_FAULT", ...options });
    } else {
      super(codeOrMessage, messageOrStatus, { category: "UPSTREAM_FAULT", ...options });
    }
  }
}

export class ValidationError extends AppError {
  constructor(codeOrMessage, messageOrStatus, options) {
    if (typeof messageOrStatus === "number") {
      super(codeOrMessage, messageOrStatus, { statusCode: messageOrStatus, category: "USER_FAULT", ...options });
    } else {
      super(codeOrMessage, messageOrStatus, { statusCode: 400, category: "USER_FAULT", ...options });
    }
  }
}

export class BillingError extends AppError {
  constructor(codeOrMessage, messageOrStatus, options) {
    if (typeof messageOrStatus === "number") {
      super(codeOrMessage, messageOrStatus, { category: "BILLING_FAULT", ...options });
    } else {
      super(codeOrMessage, messageOrStatus, { category: "BILLING_FAULT", ...options });
    }
  }
}

export class SystemError extends AppError {
  constructor(codeOrMessage, messageOrStatus, options) {
    if (typeof messageOrStatus === "number") {
      super(codeOrMessage, messageOrStatus, { type: "PROGRAMMER", category: "SERVER_FAULT", ...options });
    } else {
      super(codeOrMessage, messageOrStatus, { type: "PROGRAMMER", category: "SERVER_FAULT", ...options });
    }
  }
}

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
