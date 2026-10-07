import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { assertOwns, assertOwnsAny } from "../../src/platform/security/ownership.js";
import { db } from "../../src/container.js";
import { AppError } from "../../src/utils/AppError.js";

describe("Workflow Ownership with NULL Project User ID (Task F-T2)", () => {
  let origFindWorkflowById;
  let origGetWorkflow;
  let origFindProjectByUser;
  let origFindProjectById;

  beforeEach(() => {
    origFindWorkflowById = db.workflows?.findById;
    origGetWorkflow = db.workflows?.getWorkflow;
    origFindProjectByUser = db.projects?.findByUser;
    origFindProjectById = db.projects?.findById;
  });

  afterEach(() => {
    if (db.workflows) {
      db.workflows.findById = origFindWorkflowById;
      db.workflows.getWorkflow = origGetWorkflow;
    }
    if (db.projects) {
      db.projects.findByUser = origFindProjectByUser;
      db.projects.findById = origFindProjectById;
    }
  });

  it("User B receives 404 on workflow whose parent project has user_id NULL and workflow.user_id is NULL", async () => {
    // Workflow exists, but both workflow.user_id and parent project.user_id are NULL (e.g. unowned/legacy project)
    const nullOwnerWorkflow = {
      id: "wf-null-owner-123",
      project_id: "proj-null-owner-456",
      user_id: null,
      name: "Legacy Unowned Workflow",
    };

    db.workflows = {
      ...db.workflows,
      findById: async (id) => (id === nullOwnerWorkflow.id ? nullOwnerWorkflow : null),
      getWorkflow: async (id) => (id === nullOwnerWorkflow.id ? nullOwnerWorkflow : null),
    };

    // Neither User B nor any other user owns proj-null-owner-456
    db.projects = {
      ...db.projects,
      findByUser: async (userId, projectId) => {
        // Project in DB has user_id: null, so findByUser for user-B returns empty array
        return [];
      },
      findById: async (id) => {
        if (id === "proj-null-owner-456") {
          return { id: "proj-null-owner-456", user_id: null, name: "Unowned Project" };
        }
        return null;
      },
    };

    // User B tries to access unowned workflow -> must throw 404 AppError
    await assert.rejects(
      async () => {
        await assertOwns("workflow", "wf-null-owner-123", "user-B");
      },
      (err) => {
        assert(err instanceof AppError, "Expected err to be instance of AppError");
        assert.equal(err.statusCode, 404, "Cross-tenant / unowned access must yield 404");
        assert.match(err.message, /Workflow not found/i);
        return true;
      }
    );
  });

  it("Any authenticated user (including User A) gets 404 when workflow and project user_id are both NULL", async () => {
    const nullOwnerWorkflow = {
      id: "wf-null-owner-789",
      project_id: "proj-null-owner-789",
      user_id: null,
    };

    db.workflows = {
      ...db.workflows,
      findById: async (id) => (id === nullOwnerWorkflow.id ? nullOwnerWorkflow : null),
    };

    db.projects = {
      ...db.projects,
      findByUser: async () => [],
      findById: async () => ({ id: "proj-null-owner-789", user_id: null }),
    };

    await assert.rejects(
      async () => {
        await assertOwns("workflow", "wf-null-owner-789", "user-A");
      },
      (err) => {
        assert.equal(err.statusCode, 404);
        return true;
      }
    );
  });

  it("assertOwnsAny returns 404 for unowned workflow when checked across workflow and media types", async () => {
    const nullOwnerWorkflow = {
      id: "wf-null-owner-poly",
      project_id: "proj-null-poly",
      user_id: null,
    };

    db.workflows = {
      ...db.workflows,
      findById: async (id) => (id === nullOwnerWorkflow.id ? nullOwnerWorkflow : null),
    };

    db.projects = {
      ...db.projects,
      findByUser: async () => [],
    };

    await assert.rejects(
      async () => {
        await assertOwnsAny(["workflow", "media"], "wf-null-owner-poly", "user-B");
      },
      (err) => {
        assert.equal(err.statusCode, 404);
        return true;
      }
    );
  });

  it("Legitimate owner User A succeeds with 200/resolved record, while User B gets 404 on the same workflow", async () => {
    const ownedWorkflow = {
      id: "wf-user-A-valid",
      project_id: "proj-user-A-valid",
      user_id: "user-A",
      name: "User A Asset",
    };

    db.workflows = {
      ...db.workflows,
      findById: async (id) => (id === ownedWorkflow.id ? ownedWorkflow : null),
    };

    db.projects = {
      ...db.projects,
      findByUser: async (userId, projectId) => {
        if (userId === "user-A" && projectId === "proj-user-A-valid") {
          return [{ id: "proj-user-A-valid", user_id: "user-A" }];
        }
        return [];
      },
    };

    // User A succeeds
    const resolved = await assertOwns("workflow", "wf-user-A-valid", "user-A");
    assert.equal(resolved.id, "wf-user-A-valid");
    assert.equal(resolved.user_id, "user-A");

    // User B receives 404
    await assert.rejects(
      async () => {
        await assertOwns("workflow", "wf-user-A-valid", "user-B");
      },
      (err) => {
        assert.equal(err.statusCode, 404);
        return true;
      }
    );
  });
});
