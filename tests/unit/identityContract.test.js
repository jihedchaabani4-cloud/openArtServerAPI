import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../../src/errors/AppError.js";
import {
    IdentityError,
    IdentityAuthenticationError,
    IdentityForbiddenError,
    IdentityNotFoundError,
    IdentityValidationError,
    assertOwns,
    assertOwnsAny,
    toMediaIdList,
    setDb,
    safeCompareSecret,
    requireAuth,
    requireAdmin,
    isInternalSecretAllowedRequest,
    isInternalSecretAllowedRoute,
    USER_ID_REGEX,
    AuthorizationService,
    TenantAccessService,
    AuditService,
} from "#platform/identity";

describe("Identity System Public Contract (#platform/identity)", () => {
    describe("1. Exported Error Hierarchy", () => {
        it("IdentityError inherits from AppError with default 500 status", () => {
            const err = new IdentityError("IDENTITY_ERR", "Base identity failure");
            assert.ok(err instanceof AppError);
            assert.ok(err instanceof IdentityError);
            assert.equal(err.statusCode, 500);
            assert.equal(err.code, "IDENTITY_ERR");
        });

        it("IdentityAuthenticationError sets 401 status and UNAUTHORIZED code", () => {
            const err = new IdentityAuthenticationError("Login required");
            assert.ok(err instanceof IdentityError);
            assert.ok(err instanceof AppError);
            assert.equal(err.statusCode, 401);
            assert.equal(err.code, "UNAUTHORIZED");
            assert.equal(err.errorCode, "UNAUTHORIZED");
        });

        it("IdentityForbiddenError sets 403 status and FORBIDDEN code", () => {
            const err = new IdentityForbiddenError("Insufficient role");
            assert.ok(err instanceof IdentityError);
            assert.ok(err instanceof AppError);
            assert.equal(err.statusCode, 403);
            assert.equal(err.code, "FORBIDDEN");
            assert.equal(err.errorCode, "FORBIDDEN");
        });

        it("IdentityNotFoundError sets 404 status and NOT_FOUND code", () => {
            const err = new IdentityNotFoundError("Missing user resource");
            assert.ok(err instanceof IdentityError);
            assert.ok(err instanceof AppError);
            assert.equal(err.statusCode, 404);
            assert.equal(err.code, "NOT_FOUND");
            assert.equal(err.errorCode, "NOT_FOUND");
        });

        it("IdentityValidationError sets 400 status and VALIDATION_ERROR compatibility", () => {
            const err = new IdentityValidationError("Invalid credentials");
            assert.ok(err instanceof IdentityError);
            assert.ok(err instanceof AppError);
            assert.equal(err.statusCode, 400);
            assert.equal(err.code, "IDENTITY_VALIDATION_ERROR");
            assert.equal(err.errorCode, "VALIDATION_ERROR");
        });
    });

    describe("2. Security & Ownership Helpers", () => {
        it("exports ownership guards and formatting helpers", () => {
            assert.equal(typeof assertOwns, "function");
            assert.equal(typeof assertOwnsAny, "function");
            assert.equal(typeof toMediaIdList, "function");
            assert.equal(typeof setDb, "function");
        });

        it("safeCompareSecret performs constant-time secret evaluation", () => {
            assert.equal(typeof safeCompareSecret, "function");
            assert.equal(safeCompareSecret("my-secret-key-123", "my-secret-key-123"), true);
            assert.equal(safeCompareSecret("my-secret-key-123", "wrong-secret-key"), false);
            assert.equal(safeCompareSecret("", ""), false);
            assert.equal(safeCompareSecret(null, "expected"), false);
        });
    });

    describe("3. Middleware & Regex Exports", () => {
        it("exports HTTP middleware functions", () => {
            assert.equal(typeof requireAuth, "function");
            assert.equal(typeof requireAdmin, "function");
            assert.equal(typeof isInternalSecretAllowedRequest, "function");
            assert.equal(typeof isInternalSecretAllowedRoute, "function");
        });

        it("USER_ID_REGEX validates canonical UUID format", () => {
            assert.ok(USER_ID_REGEX instanceof RegExp);
            assert.equal(USER_ID_REGEX.test("00000000-0000-0000-0000-000000000001"), true);
            assert.equal(USER_ID_REGEX.test("not-a-uuid"), false);
        });
    });

    describe("4. Platform Services", () => {
        it("exports AuthorizationService, TenantAccessService, AuditService classes", () => {
            assert.equal(typeof AuthorizationService, "function");
            assert.equal(typeof TenantAccessService, "function");
            assert.equal(typeof AuditService, "function");

            const authService = new AuthorizationService();
            assert.equal(typeof authService.can, "function");
            assert.equal(typeof authService.assertCan, "function");
        });
    });
});
