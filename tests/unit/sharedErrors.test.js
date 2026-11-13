import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AppError,
  ProviderError,
  ValidationError,
  BillingError,
  SystemError,
  InsufficientCreditsError,
  ReservationExpiredError,
  CrudServiceError,
  safePublicRouteError,
  ErrorSystem,
  ERROR_POLICY,
} from "../../src/shared/errors/index.js";

describe("Shared Errors Hierarchy", () => {
  it("supports legacy 2-argument signature: new AppError(message, statusCode)", () => {
    const err404 = new AppError("Resource not found", 404);
    assert.equal(err404.message, "Resource not found");
    assert.equal(err404.statusCode, 404);
    assert.equal(err404.status, "fail");
    assert.equal(err404.isOperational, true);
    assert.equal(err404.code, "NOT_FOUND");
    assert.equal(err404.category, "USER_FAULT");

    const err500 = new AppError("Internal crash", 500);
    assert.equal(err500.statusCode, 500);
    assert.equal(err500.status, "error");
    assert.equal(err500.category, "SERVER_FAULT");
  });

  it("supports modern 3-argument signature: new AppError(code, message, options)", () => {
    const err = new AppError("CUSTOM_CODE", "Something failed", {
      statusCode: 422,
      category: "USER_FAULT",
      retryable: true,
      billingAction: "ROLLBACK",
      context: { foo: "bar" },
    });

    assert.equal(err.code, "CUSTOM_CODE");
    assert.equal(err.message, "Something failed");
    assert.equal(err.statusCode, 422);
    assert.equal(err.status, "fail");
    assert.equal(err.retryable, true);
    assert.equal(err.billingAction, "ROLLBACK");
    assert.deepEqual(err.context, { foo: "bar" });
  });

  it("subclasses inherit correct categories and status codes", () => {
    const valErr = new ValidationError("INVALID_FIELD", "Missing email");
    assert.equal(valErr.statusCode, 400);
    assert.equal(valErr.category, "USER_FAULT");

    const provErr = new ProviderError("UPSTREAM_FAIL", "Fal AI timeout");
    assert.equal(provErr.category, "UPSTREAM_FAULT");

    const creditErr = new InsufficientCreditsError(10, 2);
    assert.equal(creditErr.code, "INSUFFICIENT_CREDITS");
    assert.equal(creditErr.statusCode, 402);
    assert.equal(creditErr.category, "BILLING_FAULT");
    assert.equal(creditErr.required, 10);
    assert.equal(creditErr.available, 2);

    const expiredErr = new ReservationExpiredError("res-123");
    assert.equal(expiredErr.code, "RESERVATION_EXPIRED");
    assert.equal(expiredErr.statusCode, 409);
    assert.equal(expiredErr.reservationId, "res-123");
  });

  it("CrudServiceError initializes correctly", () => {
    const err = new CrudServiceError("Failed to update entity", {
      statusCode: 404,
      errorCode: "ENTITY_NOT_FOUND",
      entityId: "123",
    });
    assert.equal(err.name, "CrudServiceError");
    assert.equal(err.statusCode, 404);
    assert.equal(err.errorCode, "ENTITY_NOT_FOUND");
    assert.equal(err.entityId, "123");
  });

  it("safePublicRouteError masks 5xx and preserves 4xx contracts", () => {
    const err500 = new Error("Database connection leak on 10.0.0.1:5432");
    const masked = safePublicRouteError(err500);
    assert.equal(masked.statusCode, 500);
    assert.equal(masked.errorCode, "INTERNAL_ERROR");
    assert.equal(masked.publicMessage, "Internal server error");

    const err404 = new AppError("Item not found", 404);
    const pass404 = safePublicRouteError(err404);
    assert.equal(pass404.statusCode, 404);
    assert.equal(pass404.errorCode, "NOT_FOUND");
    assert.equal(pass404.publicMessage, "Item not found");

    const errCustom = { statusCode: 402, errorCode: "INSUFFICIENT_CREDITS", message: "Need credits" };
    const passCustom = safePublicRouteError(errCustom);
    assert.equal(passCustom.statusCode, 402);
    assert.equal(passCustom.errorCode, "INSUFFICIENT_CREDITS");
    assert.equal(passCustom.publicMessage, "Need credits");
  });

  it("ErrorSystem processes errors into user and system reports according to policy", () => {
    const appErr = new InsufficientCreditsError(20, 5);
    const processed = ErrorSystem.process(appErr, { nodeId: "node-1", runId: "run-99" });

    assert.equal(processed.user.code, "INSUFFICIENT_CREDITS");
    assert.equal(processed.user.statusCode, 402);
    assert.equal(processed.user.category, "BILLING_FAULT");
    assert.equal(processed.user.nodeId, "node-1");
    assert.equal(processed.system.traceId, "run-99");
    assert.equal(processed.actions.billingAction, "NONE");
    assert.equal(processed.actions.shouldRefund, false);
  });
});
