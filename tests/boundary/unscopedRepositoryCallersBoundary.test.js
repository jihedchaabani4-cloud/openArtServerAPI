import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generationService, db } from "../../src/container.js";

describe("RC1.4-D3(5) — Repository Methods Without User Filter Caller Safety", () => {
  let origFindByUser;
  let origFindByIdInProjects;
  let origDeleteById;

  beforeEach(() => {
    origFindByUser = db.projects?.findByUser;
    origFindByIdInProjects = db.workflows?.findByIdInProjects;
    origDeleteById = db.workflows?.deleteById;

    if (db.projects) {
      db.projects.findByUser = async (userId) => {
        if (userId === "user-A") return [{ id: "proj-A", user_id: "user-A" }];
        return [];
      };
    }

    if (db.workflows) {
      db.workflows.findByIdInProjects = async (workflowId, projectIds) => {
        if (workflowId === "wf-A" && projectIds.includes("proj-A")) {
          return { id: "wf-A", project_id: "proj-A" };
        }
        return null;
      };
      db.workflows.deleteById = async (id) => ({ id, deleted: true });
    }
  });

  afterEach(() => {
    if (db.projects) db.projects.findByUser = origFindByUser;
    if (db.workflows) {
      db.workflows.findByIdInProjects = origFindByIdInProjects;
      db.workflows.deleteById = origDeleteById;
    }
  });

  it("TEST 1: generationService.deleteGeneration enforces project ownership when userId provided", async () => {
    // Foreign user (user-B) attempting to delete user-A's workflow must throw 404
    await assert.rejects(
      async () => {
        await generationService.deleteGeneration("user-B", "wf-A");
      },
      (err) => {
        assert.equal(err.statusCode, 404);
        assert.match(err.message, /workflow not found/i);
        return true;
      }
    );
  });

  it("TEST 2: generationService.deleteGeneration succeeds when user owns the workflow", async () => {
    const res = await generationService.deleteGeneration("user-A", "wf-A");
    assert.deepEqual(res, { ok: true });
  });
});
