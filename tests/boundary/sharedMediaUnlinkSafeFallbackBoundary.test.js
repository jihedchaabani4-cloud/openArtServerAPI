import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorkflowMediaService } from "#generation/tools";
import { WorkflowMediaRepository } from "#media/tools";
import { CrudServiceError } from "#shared";

describe("Shared-Media Unlink Safe Fallback & Schema Integrity Boundary", () => {
  it("TEST 1: Missing RPC (error 42883) fails closed with SERVICE_UNAVAILABLE and preserves storage", async () => {
    const deletedStorage = [];
    const mediaId = "media-missing-rpc-1";
    const wfId = "wf-missing-rpc-1";
    const userId = "user-1";
    const storageUrl = "https://storage.local/media-missing-rpc-1.png";

    // Mock repository with client returning error code 42883 (undefined_function)
    const mockClient = {
      from: () => ({
        delete: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
        select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
      }),
      rpc: async (funcName) => {
        if (funcName === "unlink_workflow_media_and_reap_orphan") {
          const err = new Error("function public.unlink_workflow_media_and_reap_orphan(uuid, uuid, text) does not exist");
          err.code = "42883";
          return { data: null, error: err };
        }
        return { data: null, error: null };
      },
    };

    const repo = new WorkflowMediaRepository();
    repo.client = () => mockClient;

    const mockDb = {
      workflowMedia: repo,
      media: {
        findById: async () => ({ id: mediaId, url: storageUrl }),
        deleteById: async () => {
          throw new Error("deleteById should not be called when RPC fails closed");
        },
      },
      workflows: {
        findById: async () => ({ id: wfId, primary_media_id: null }),
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
      verifyWorkflowOwnership: async () => true,
      verifyMediaOwnership: async () => true,
    };

    const service = new WorkflowMediaService({
      db: mockDb,
      storageService: mockStorage,
      authService: mockAuth,
      mediaUploadService: { discard: async () => ({}) },
    });

    // Calling deleteMedia when atomic RPC is missing must FAIL CLOSED
    await assert.rejects(
      async () => {
        await service.deleteMedia({ workflowId: wfId, mediaId, userId });
      },
      (err) => {
        assert.ok(err instanceof CrudServiceError || err.statusCode === 503 || err.code === "RPC_UNAVAILABLE" || err.errorCode === "SERVICE_UNAVAILABLE", `Expected 503/SERVICE_UNAVAILABLE, got: ${err.message}`);
        return true;
      }
    );

    // Physical storage file must NEVER be deleted
    assert.equal(deletedStorage.length, 0, "Storage must NOT be deleted when atomic RPC is unavailable");
  });

  it("TEST 2: Unexpected schema error (e.g. 42703 undefined_column) propagates and does NOT trigger fallback", async () => {
    const deletedStorage = [];
    const mediaId = "media-col-err-1";
    const wfId = "wf-col-err-1";
    const userId = "user-1";
    const storageUrl = "https://storage.local/media-col-err-1.png";

    // Simulate PostgreSQL error 42703 (undefined_column: column "primary_media_id" of relation "workflow" does not exist)
    const mockClient = {
      from: () => ({
        delete: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
        select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
      }),
      rpc: async (funcName) => {
        if (funcName === "unlink_workflow_media_and_reap_orphan") {
          const err = new Error('column "primary_media_id" of relation "workflow" does not exist');
          err.code = "42703";
          return { data: null, error: err };
        }
        return { data: null, error: null };
      },
    };

    const repo = new WorkflowMediaRepository();
    repo.client = () => mockClient;

    const mockDb = {
      workflowMedia: repo,
      media: {
        findById: async () => ({ id: mediaId, url: storageUrl }),
        deleteById: async () => {},
      },
      workflows: {
        findById: async () => ({ id: wfId, primary_media_id: null }),
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
      verifyWorkflowOwnership: async () => true,
      verifyMediaOwnership: async () => true,
    };

    const service = new WorkflowMediaService({
      db: mockDb,
      storageService: mockStorage,
      authService: mockAuth,
      mediaUploadService: { discard: async () => ({}) },
    });

    // The unexpected schema error must propagate, NOT be swallowed or treated as missing RPC
    await assert.rejects(
      async () => {
        await service.deleteMedia({ workflowId: wfId, mediaId, userId });
      },
      (err) => {
        // Must indicate schema/database error, not a successful fallback
        assert.ok(
          err.code === "42703" || err.message?.includes("primary_media_id") || err.statusCode === 500,
          `Expected 42703 error to propagate, got: ${err.message}`
        );
        return true;
      }
    );

    assert.equal(deletedStorage.length, 0, "Storage must not be touched on database schema error");
  });

  it("TEST 3: Fallback sequential unlink does not authorize storage deletion even if count is 0", async () => {
    // If unlinkAndReapOrphan is invoked in a non-atomic environment, it must NEVER report is_orphan: true
    const repo = new WorkflowMediaRepository();
    // Simulate non-RPC mode where unlinkAndReapOrphan is explicitly invoked
    const mockClient = {
      from: () => ({
        delete: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
        select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
      }),
      rpc: async () => ({
        data: null,
        error: Object.assign(new Error("RPC unavailable"), { code: "42883" }),
      }),
    };
    repo.client = () => mockClient;

    await assert.rejects(
      async () => {
        await repo.unlinkAndReapOrphan({ workflowId: "wf-1", mediaId: "media-1" });
      },
      (err) => {
        assert.ok(
          err.code === "RPC_UNAVAILABLE" || err.statusCode === 503 || err.message?.includes("unavailable"),
          `Expected RPC_UNAVAILABLE rejection, got ${err.message}`
        );
        return true;
      }
    );
  });

  it("TEST 4: WorkflowMediaRepository.attachReferenceMedia coordinates via atomic RPC and respects quota", async () => {
    const repo = new WorkflowMediaRepository();
    let rpcCalledWith = null;

    const mockClient = {
      from: () => ({
        select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
      }),
      rpc: async (name, params) => {
        if (name === "attach_workflow_reference_media") {
          rpcCalledWith = params;
          return {
            data: {
              workflow_id: params.p_workflow_id,
              media_id: params.p_media_id,
              role: params.p_role,
              is_primary: true,
              current_count: 1,
              max_allowed: params.p_max_allowed,
            },
            error: null,
          };
        }
        return { data: null, error: null };
      },
    };
    repo.client = () => mockClient;

    const result = await repo.attachReferenceMedia({
      workflowId: "wf-ref-1",
      mediaId: "media-ref-1",
      role: "detail",
      maxAllowed: 6,
    });

    assert.ok(rpcCalledWith, "RPC attach_workflow_reference_media must be invoked");
    assert.equal(rpcCalledWith.p_workflow_id, "wf-ref-1");
    assert.equal(rpcCalledWith.p_media_id, "media-ref-1");
    assert.equal(rpcCalledWith.p_max_allowed, 6);
    assert.equal(result.is_primary, true);
  });

  it("TEST 5: attachReferenceMedia enforces strict quota under memory mode", async () => {
    WorkflowMediaRepository.enableTestMemoryFallback();
    WorkflowMediaRepository.clearMemory();
    const repo = new WorkflowMediaRepository();

    const wfId = "wf-quota-test";
    // Attach 6 reference images
    for (let i = 1; i <= 6; i++) {
      await repo.attachReferenceMedia({
        workflowId: wfId,
        mediaId: `media-slot-${i}`,
        role: "detail",
        maxAllowed: 6,
      });
    }

    // 7th image must be rejected with quota limit error
    await assert.rejects(
      async () => {
        await repo.attachReferenceMedia({
          workflowId: wfId,
          mediaId: "media-slot-7",
          role: "detail",
          maxAllowed: 6,
        });
      },
      (err) => {
        assert.ok(err.code === "23514" || err.message?.includes("Maximum 6"), `Expected quota limit error, got: ${err.message}`);
        return true;
      }
    );
  });
});
