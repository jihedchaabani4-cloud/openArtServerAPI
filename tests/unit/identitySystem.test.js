import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  identityTools,
  verifySession,
  getUserProfile,
  assertOwns,
  assertOwnsAny,
  toMediaIdList,
  setDb,
  IdentityAuthenticationError,
  IdentityForbiddenError,
  IdentityNotFoundError,
  IdentityValidationError,
} from "#identity/tools";
import { identityRouter, signup, login } from "#identity/api";

describe("System 5: Identity & Auth (#identity/tools and #identity/api)", () => {
  it("exports identityTools and individual contract methods", () => {
    assert.equal(typeof identityTools.verifySession, "function");
    assert.equal(typeof identityTools.getUserProfile, "function");
    assert.equal(typeof identityTools.assertOwns, "function");
    assert.equal(typeof identityTools.assertOwnsAny, "function");
    assert.equal(typeof identityTools.toMediaIdList, "function");
  });

  it("exports Express identityRouter", () => {
    assert.ok(identityRouter);
    assert.equal(typeof identityRouter, "function");
  });

  it("normalizes media and reference parameters with toMediaIdList", () => {
    assert.deepEqual(toMediaIdList(null), []);
    assert.deepEqual(toMediaIdList(" id-123 "), ["id-123"]);
    assert.deepEqual(toMediaIdList({ id: " id-obj " }), ["id-obj"]);
    assert.deepEqual(toMediaIdList({ workflowId: "wf-1" }), ["wf-1"]);
    assert.deepEqual(toMediaIdList([" a ", { mediaId: " b " }, ""]), ["a", "b"]);
  });

  it("assertOwns enforces ownership and throws 404 on missing or unowned resource (anti-enumeration)", async () => {
    const mockDb = {
      projects: {
        findById: async (id) => {
          if (id === "proj-1") return { id: "proj-1", user_id: "user-owner" };
          return null;
        },
      },
    };
    setDb(mockDb);

    // Owned resource passes
    const owned = await assertOwns("project", "proj-1", "user-owner");
    assert.equal(owned.id, "proj-1");

    // Missing resource throws 404
    await assert.rejects(
      async () => assertOwns("project", "non-existent", "user-owner"),
      (err) => err.statusCode === 404 && err.message.includes("Project not found")
    );

    // Unowned resource throws 404 (anti-enumeration mask)
    await assert.rejects(
      async () => assertOwns("project", "proj-1", "user-attacker"),
      (err) => err.statusCode === 404 && err.message.includes("Project not found")
    );
  });

  it("assertOwnsAny checks multiple resource types sequentially", async () => {
    const mockDb = {
      projects: {
        findById: async () => null,
      },
      characters: {
        findById: async (id) => {
          if (id === "char-1") return { id: "char-1", user_id: "user-1" };
          return null;
        },
      },
    };
    setDb(mockDb);

    const match = await assertOwnsAny(["project", "character"], "char-1", "user-1");
    assert.equal(match.id, "char-1");

    await assert.rejects(
      async () => assertOwnsAny(["project", "character"], "char-99", "user-1"),
      (err) => err.statusCode === 404
    );
  });

  it("Identity errors have correct codes and status codes", () => {
    const authErr = new IdentityAuthenticationError("Please log in");
    assert.equal(authErr.statusCode, 401);
    assert.equal(authErr.code, "UNAUTHORIZED");

    const forbErr = new IdentityForbiddenError();
    assert.equal(forbErr.statusCode, 403);
    assert.equal(forbErr.code, "FORBIDDEN");

    const valErr = new IdentityValidationError("Bad email");
    assert.equal(valErr.statusCode, 400);
    assert.equal(valErr.code, "IDENTITY_VALIDATION_ERROR");
  });

  it("verifySession returns DTO when req.user is set", async () => {
    const req = { user: { id: "u-123", email: "u@example.com", role: "admin" } };
    const session = await verifySession(req);
    assert.deepEqual(session, {
      userId: "u-123",
      email: "u@example.com",
      role: "admin",
    });
  });
});
