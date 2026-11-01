import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { WorkflowMediaService } from "../../src/platform/workflow/WorkflowMediaService.js";
import { deleteMedia as workflowsControllerDeleteMedia } from "../../controllers/workflowsController.js";
import { WorkflowMediaRepository } from "../../src/db/WorkflowMediaRepository.js";
import { workflowService } from "../../src/container.js";

describe("Task A: Scoped Media Deletion & Shared-Media Lifecycle Boundary Tests", () => {
  beforeEach(() => {
    WorkflowMediaRepository.enableTestMemoryFallback();
  });

  it("TEST 1: deleteMedia for an owned media without workflow context fails safely with a 400 client error", async () => {
    let statusCode = null;
    let jsonPayload = null;

    const req = {
      params: { media_id: "media-shared-1" },
      query: {},
      body: {},
      user: { id: "user-1" },
    };

    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(payload) {
        jsonPayload = payload;
        return this;
      },
    };

    // The media is owned by the caller; without this override the fail-closed
    // authorization service would deny a media row that does not exist in the
    // test database, masking the workflow-context validation under test.
    const origAuth = workflowService.authService?.verifyMediaOwnership;
    try {
      if (workflowService?.authService) {
        workflowService.authService.verifyMediaOwnership = async () => true;
      }
      await workflowsControllerDeleteMedia(req, res);
    } finally {
      if (origAuth) {
        workflowService.authService.verifyMediaOwnership = origAuth;
      }
    }

    assert.equal(statusCode, 400, "Must return HTTP 400 when workflow context is omitted");
    assert.match(String(jsonPayload?.message || ""), /workflow.*required/i, "Error must state that workflow context is required");
  });

  it("TEST 1b: deleteMedia for a nonexistent media returns 404 (fail-closed, no workflow-context leak)", async () => {
    let statusCode = null;
    let jsonPayload = null;

    const req = {
      params: { media_id: "media-shared-1" },
      query: {},
      body: {},
      user: { id: "user-1" },
    };

    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(payload) {
        jsonPayload = payload;
        return this;
      },
    };

    await workflowsControllerDeleteMedia(req, res);

    assert.equal(statusCode, 404, "Unknown media must be denied as not found (fail-closed)");
    assert.equal(jsonPayload?.ok, false);
  });

  it("TEST 2: deleteMedia for cross-tenant / unauthorized workflow returns 404 without information leak", async () => {
    let statusCode = null;
    let jsonPayload = null;

    const req = {
      params: { media_id: "media-shared-1" },
      query: { workflow_id: "wf-tenant-b" },
      body: {},
      user: { id: "attacker-tenant-a" },
    };

    const res = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(payload) {
        jsonPayload = payload;
        return this;
      },
    };

    await workflowsControllerDeleteMedia(req, res);

    assert.equal(statusCode, 404, "Cross-tenant access must return HTTP 404");
    assert.equal(jsonPayload?.ok, false);
  });

  it("TEST 3: Removing media from workflow A preserves association in workflow B and preserves storage asset", async () => {
    const repo = new WorkflowMediaRepository();
    const mediaId = "media-shared-123";
    const wfA = "wf-user1-a";
    const wfB = "wf-user1-b";
    const userId = "user-1";
    const storageUrl = "https://storage.local/media-shared-123.png";

    // Link media to both workflows
    await repo.linkMedia({ workflowId: wfA, mediaId, role: "output" });
    await repo.linkMedia({ workflowId: wfB, mediaId, role: "reference" });

    assert.equal(await repo.countLinksForMedia(mediaId), 2, "Media must be linked to 2 workflows initially");

    const deletedStorage = [];
    const mediaStore = new Map([[mediaId, { id: mediaId, url: storageUrl }]]);

    const mockDb = {
      workflowMedia: repo,
      media: {
        findById: async (id) => mediaStore.get(id) || null,
        deleteById: async (id) => {
          mediaStore.delete(id);
          return { id };
        },
        findByWorkflow: async (wfId) => {
          const links = await repo.findByWorkflow(wfId);
          return links.map((l) => ({ id: l.media_id, workflow_id: wfId }));
        },
      },
      workflows: {
        findById: async (wfId) => ({ id: wfId, primary_media_id: null }),
        deleteById: async () => {},
        updatePrimaryMedia: async () => {},
      },
    };

    const mockStorage = {
      deleteByUrl: async (url) => {
        deletedStorage.push(url);
      },
    };

    const mockAuth = {
      verifyWorkflowOwnership: async (wfId, uId) => uId === userId && (wfId === wfA || wfId === wfB),
      verifyMediaOwnership: async (mId, uId) => uId === userId && mId === mediaId,
    };

    const service = new WorkflowMediaService({
      db: mockDb,
      storageService: mockStorage,
      authService: mockAuth,
      mediaUploadService: { discard: async () => ({}) },
    });

    // Delete from Workflow A
    const result = await service.deleteMedia({
      mediaId,
      workflowId: wfA,
      userId,
    });

    assert.equal(result.deleted, false, "Media row must NOT be deleted while Workflow B still links to it");
    assert.equal(await repo.countLinksForMedia(mediaId), 1, "Exactly one association (Workflow B) must remain");
    
    const remainingWfB = await repo.findByWorkflow(wfB);
    assert.equal(remainingWfB.some((r) => r.media_id === mediaId), true, "Workflow B must still be linked to media");

    const remainingWfA = await repo.findByWorkflow(wfA);
    assert.equal(remainingWfA.some((r) => r.media_id === mediaId), false, "Workflow A association must be removed");

    assert.equal(mediaStore.has(mediaId), true, "Media database row must be preserved");
    assert.equal(deletedStorage.length, 0, "Supabase storage object must NOT be deleted");
  });

  it("TEST 4: Removing the last remaining association deletes media row and storage asset", async () => {
    const repo = new WorkflowMediaRepository();
    const mediaId = "media-final-unlink";
    const wfA = "wf-only-one";
    const userId = "user-1";
    const storageUrl = "https://storage.local/media-final.png";

    await repo.linkMedia({ workflowId: wfA, mediaId, role: "output" });
    assert.equal(await repo.countLinksForMedia(mediaId), 1);

    const deletedStorage = [];
    const mediaStore = new Map([[mediaId, { id: mediaId, url: storageUrl }]]);

    const mockDb = {
      workflowMedia: repo,
      media: {
        findById: async (id) => mediaStore.get(id) || null,
        deleteById: async (id) => {
          mediaStore.delete(id);
          return { id };
        },
        findByWorkflow: async () => [],
      },
      workflows: {
        findById: async (wfId) => ({ id: wfId, primary_media_id: null }),
        deleteById: async () => {},
        updatePrimaryMedia: async () => {},
      },
    };

    const mockStorage = {
      deleteByUrl: async (url) => {
        deletedStorage.push(url);
      },
    };

    const mockAuth = {
      verifyWorkflowOwnership: async (wfId, uId) => uId === userId && wfId === wfA,
      verifyMediaOwnership: async (mId, uId) => uId === userId && mId === mediaId,
    };

    const service = new WorkflowMediaService({
      db: mockDb,
      storageService: mockStorage,
      authService: mockAuth,
      mediaUploadService: { discard: async () => ({}) },
    });

    const result = await service.deleteMedia({
      mediaId,
      workflowId: wfA,
      userId,
    });

    assert.equal(result.deleted, true, "Media row must be reported as deleted");
    assert.equal(await repo.countLinksForMedia(mediaId), 0, "No associations remain");
    assert.equal(mediaStore.has(mediaId), false, "Media database record must be deleted");
    assert.deepEqual(deletedStorage, [storageUrl], "Storage object must be deleted for orphan");
  });
});
