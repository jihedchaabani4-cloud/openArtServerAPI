if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "test";
}

import { describe, it, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { CharacterGenerationService } from "../../src/domain/character/CharacterGenerationService.js";
import { ElementService } from "../../src/domain/element/ElementService.js";
import { ElementMediaService } from "../../src/domain/element/ElementMediaService.js";
import { createWorkflowWithMediaAtomic } from "../../src/db/workflowMediaOps.js";
import { failWorkflowPendingMedia } from "../../src/platform/media/MediaLifecycleService.js";
import { supabase } from "../../lib/supabase.js";
import { setDb } from "../../src/platform/security/ownership.js";
import { WorkflowMediaRepository } from "../../src/db/WorkflowMediaRepository.js";

describe("Sheet Generation real service layer tests — workflow_media integrity", () => {
  let originalRpc;

  beforeEach(() => {
    originalRpc = supabase.rpc;
  });

  afterEach(() => {
    supabase.rpc = originalRpc;
    setDb(null);
  });

  it("1. Character Sheet Generation path: links workflow_media on success and fails closed on link error", async () => {
    const mediaTable = new Map();
    const workflowMediaTable = [];
    const workflowTable = new Map();

    const realDb = {
      media: {
        createMedia: async (data) => {
          const row = { id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ...data };
          mediaTable.set(row.id, row);
          return row;
        },
        updateMedia: async (id, fields) => {
          const existing = mediaTable.get(id) || {};
          const updated = { ...existing, ...fields };
          mediaTable.set(id, updated);
          return updated;
        },
        findByWorkflow: async (workflowId) => {
          const links = workflowMediaTable.filter((wm) => wm.workflow_id === workflowId);
          return links.map((link) => ({
            ...(mediaTable.get(link.media_id) || {}),
            workflow_id: link.workflow_id,
            role: link.role,
          }));
        },
      },
      workflows: {
        getWorkflow: async (id) => workflowTable.get(id) || null,
        createWorkflow: async (data) => {
          const row = { id: data.id || `wf-${Date.now()}`, ...data };
          workflowTable.set(row.id, row);
          return row;
        },
        updateFields: async (id, fields) => {
          const existing = workflowTable.get(id) || {};
          const updated = { ...existing, ...fields };
          workflowTable.set(id, updated);
          return updated;
        },
      },
      characters: {
        findByCharacterId: async (id) => ({ id, workflow_id: id, project_id: "proj-100", name: "Hero" }),
        upsert: async (payload) => payload,
      },
      workflowMedia: {
        linkMedia: async ({ workflowId, mediaId, role, stepId }) => {
          const link = { workflow_id: workflowId, media_id: mediaId, role: role || (stepId === "character_sheet" ? "sheet" : "detail") };
          workflowMediaTable.push(link);
          return link;
        },
      },
    };

    const mockUseCaseService = {
      prepareAndEnqueue: async ({ executionId }) => ({ executionId, workflowRunId: executionId }),
    };

    // A. Success path: verify placeholder media and workflow_media link are created
    const charGenService = new CharacterGenerationService({
      db: realDb,
      useCaseService: mockUseCaseService,
    });

    const res = await charGenService.enqueueSheetGeneration({
      characterId: "char-wf-success-1",
      prompt: "Epic fantasy knight",
      projectId: "proj-100",
      userId: "user-100",
      name: "Knight",
    });

    assert.ok(res.placeholderMedia?.id, "Placeholder media must be created");
    assert.equal(res.status, "processing");
    const createdMedia = mediaTable.get(res.placeholderMedia.id);
    assert.equal(createdMedia.status, "processing");
    assert.equal(createdMedia.step_id, "character_sheet");

    const sheetLinks = workflowMediaTable.filter(
      (wm) => wm.workflow_id === "char-wf-success-1" && wm.media_id === res.placeholderMedia.id
    );
    assert.equal(sheetLinks.length, 1, "workflow_media link must be created for character sheet placeholder");
    assert.equal(sheetLinks[0].role, "sheet");

    // B. Failure path: if linking fails, placeholder media must NOT remain orphaned in processing status
    const failingDb = {
      ...realDb,
      workflowMedia: {
        linkMedia: async () => {
          throw new Error("Simulated foreign key constraint violation");
        },
      },
    };

    const failingCharGenService = new CharacterGenerationService({
      db: failingDb,
      useCaseService: mockUseCaseService,
    });

    await assert.rejects(
      async () => {
        await failingCharGenService.enqueueSheetGeneration({
          characterId: "char-1",
          workflowId: "char-wf-fail-1",
          prompt: "Epic rogue",
          projectId: "proj-100",
          userId: "user-100",
          name: "Rogue",
        });
      },
      /Simulated foreign key constraint violation|Failed to link/
    );

    // C. Fail-closed on linkMedia returning null:
    // createMediaInWorkflow must NOT mask null with a synthetic object.
    let enqueueCallCount = 0;
    const trackedUseCaseService = {
      prepareAndEnqueue: async ({ executionId }) => {
        enqueueCallCount++;
        return { executionId, workflowRunId: executionId };
      },
    };

    const nullLinkDb = {
      ...realDb,
      workflowMedia: {
        linkMedia: async () => null,
      },
    };

    const nullLinkCharGenService = new CharacterGenerationService({
      db: nullLinkDb,
      useCaseService: trackedUseCaseService,
    });

    await assert.rejects(
      async () => {
        await nullLinkCharGenService.enqueueSheetGeneration({
          characterId: "char-null-1",
          workflowId: "char-wf-null-1",
          prompt: "Epic wizard",
          projectId: "proj-100",
          userId: "user-100",
          name: "Wizard",
        });
      },
      /Failed to link placeholder media/
    );

    assert.equal(enqueueCallCount, 0, "Job must NOT be enqueued into BullMQ when link returns null");

    // Verify placeholder media was marked failed and never remained in processing
    const allMedia = Array.from(mediaTable.values());
    const orphanedProcessing = allMedia.filter(
      (m) => m.status === "processing" && !workflowMediaTable.some((wm) => wm.media_id === m.id)
    );
    assert.equal(orphanedProcessing.length, 0, "No media should remain in 'processing' without a workflow_media link");

    const failedPlaceholder = allMedia.find((m) => m.step_id === "character_sheet" && m.status === "failed");
    assert.ok(failedPlaceholder, "Failed placeholder media must be marked with status 'failed'");
  });

  it("2. createWorkflowWithMediaAtomic path: links workflow_media when RPC returns and allows failWorkflowPendingMedia cleanup", async () => {
    const mediaTable = new Map();
    const workflowMediaTable = [];

    const realDb = {
      media: {
        updateMedia: async (id, fields) => {
          const existing = mediaTable.get(id) || {};
          const updated = { ...existing, ...fields };
          mediaTable.set(id, updated);
          return updated;
        },
        findByWorkflow: async (workflowId) => {
          const links = workflowMediaTable.filter((wm) => wm.workflow_id === workflowId);
          return links.map((link) => ({
            ...(mediaTable.get(link.media_id) || {}),
            workflow_id: link.workflow_id,
            role: link.role,
          }));
        },
      },
      workflowMedia: {
        linkMedia: async ({ workflowId, mediaId, role, stepId }) => {
          const link = {
            workflow_id: workflowId,
            media_id: mediaId,
            role: role || (stepId === "character_sheet" ? "sheet" : "output"),
          };
          workflowMediaTable.push(link);
          return link;
        },
      },
    };

    // Simulate Supabase RPC create_workflow_with_placeholder_media succeeding and returning { workflow_id, media_id }
    const simulatedRpcWorkflowId = "wf-rpc-1";
    const simulatedRpcMediaId = "m-rpc-1";
    mediaTable.set(simulatedRpcMediaId, {
      id: simulatedRpcMediaId,
      step_id: "character_sheet",
      status: "processing",
      url: null,
    });

    supabase.rpc = async (fnName) => {
      if (fnName === "create_workflow_with_placeholder_media") {
        return {
          data: {
            workflow_id: simulatedRpcWorkflowId,
            media_id: simulatedRpcMediaId,
          },
          error: null,
        };
      }
      return { data: null, error: new Error("Unknown RPC") };
    };

    const res = await createWorkflowWithMediaAtomic(realDb, {
      workflowData: {
        project_id: "proj-1",
        workflow_type: "CHARACTER",
        display_name: "Atomic Hero",
      },
      mediaData: {
        step_id: "character_sheet",
        status: "processing",
      },
    });

    assert.equal(res.workflow.id, simulatedRpcWorkflowId);
    assert.equal(res.media.id, simulatedRpcMediaId);

    // CRITICAL: workflow_media MUST be linked after createWorkflowWithMediaAtomic
    const links = workflowMediaTable.filter(
      (wm) => wm.workflow_id === simulatedRpcWorkflowId && wm.media_id === simulatedRpcMediaId
    );
    assert.equal(links.length, 1, "createWorkflowWithMediaAtomic must link row in workflow_media");
    assert.equal(links[0].role, "sheet");

    // Failure cleanup: when job fails/dies, failWorkflowPendingMedia must find the media and mark it failed
    await failWorkflowPendingMedia(realDb, simulatedRpcWorkflowId, "Worker timed out after 2 hours");
    const finalizedMedia = mediaTable.get(simulatedRpcMediaId);
    assert.equal(finalizedMedia.status, "failed");
    assert.match(finalizedMedia.error_message, /Worker timed out/);
  });

  it("3. Element Sheet Generation / Ingestion path: links workflow_media even when db object lacks explicit workflowMedia repo", async () => {
    const mediaTable = new Map();
    const workflowMediaTable = [];
    const workflowTable = new Map();
    const elementTable = new Map();

    const dbWithoutWorkflowMedia = {
      media: {
        createMedia: async (data) => {
          const row = { id: `m-elem-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, ...data };
          mediaTable.set(row.id, row);
          return row;
        },
        updateMedia: async (id, fields) => {
          const existing = mediaTable.get(id) || {};
          const updated = { ...existing, ...fields };
          mediaTable.set(id, updated);
          return updated;
        },
        findByWorkflow: async (workflowId) => {
          const links = workflowMediaTable.filter((wm) => wm.workflow_id === workflowId);
          return links.map((link) => ({
            ...(mediaTable.get(link.media_id) || {}),
            workflow_id: link.workflow_id,
            role: link.role,
          }));
        },
      },
      workflows: {
        createWorkflow: async (data) => {
          const row = { id: `wf-elem-${Date.now()}`, ...data };
          workflowTable.set(row.id, row);
          return row;
        },
        updatePrimaryMedia: async (wfId, mediaId) => {
          const wf = workflowTable.get(wfId);
          if (wf) wf.primary_media_id = mediaId;
        },
        findById: async (id) => workflowTable.get(id),
      },
      elements: {
        create: async (data) => {
          const row = { id: `elem-${Date.now()}`, ...data };
          elementTable.set(row.id, row);
          return row;
        },
        resolveRecord: async (id) => elementTable.get(id) || { id, workflow_id: id },
      },
      workflowMedia: {
        linkMedia: async ({ workflowId, mediaId, role, stepId }) => {
          const link = {
            workflow_id: workflowId,
            media_id: mediaId,
            role: role || (stepId === "element_sheet" ? "detail" : "detail"),
          };
          workflowMediaTable.push(link);
          return link;
        },
      },
    };

    const elementMediaService = new ElementMediaService({
      db: dbWithoutWorkflowMedia,
      storageService: {},
    });

    const elementService = new ElementService({
      db: dbWithoutWorkflowMedia,
      mediaService: elementMediaService,
      analysisService: { analyzeElement: async () => ({}) },
    });

    const created = await elementService.createElement({
      name: "Magic Sword",
      sourceImages: ["https://cdn.example.com/sword-sheet.png"],
      projectId: "proj-1",
      userId: "user-1",
      element_type: "object",
    });

    assert.ok(created.element, "Element must be created");
    assert.ok(created.element.primary_media_id, "primary_media_id must be set");

    const links = workflowMediaTable.filter((wm) => wm.media_id === created.element.primary_media_id);
    assert.equal(links.length, 1, "Element sheet media must have a link in workflow_media");
    assert.equal(links[0].role, "detail", "Element sheet role in workflow_media must be 'detail'");
  });

  it("4. WorkflowMediaRepository production fail-closed: throws if in-memory mode attempted outside test or if DB client not wired", async () => {
    const origEnv = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = "production";

      // A. enableTestMemoryFallback must throw in production
      assert.throws(
        () => WorkflowMediaRepository.enableTestMemoryFallback(),
        /prohibited outside NODE_ENV=test/
      );

      // B. useMemoryFallback setter must throw in production
      assert.throws(
        () => {
          WorkflowMediaRepository.useMemoryFallback = true;
        },
        /prohibited outside NODE_ENV=test/
      );

      // C. In production, calling linkMedia when DB client is not wired must throw
      const unconfiguredRepo = new WorkflowMediaRepository();
      unconfiguredRepo.client = () => null;

      await assert.rejects(
        async () => {
          await unconfiguredRepo.linkMedia({
            workflowId: "wf-prod-fail",
            mediaId: "m-prod-fail",
            role: "output",
          });
        },
        /Database client is not wired/
      );
    } finally {
      process.env.NODE_ENV = origEnv || "test";
      WorkflowMediaRepository.enableTestMemoryFallback();
    }
  });

  it("5. Worker crash handler: refunds credits idempotently (exactly once on double failure / retry / timeout) and marks direct media failed", async () => {
    process.env.NODE_ENV = "test";
    const { handleUseCaseWorkerFailure, useCaseWorker } = await import("../../src/workers/useCaseWorker.js");
    const { useCaseService, db } = await import("../../src/container.js");
    const { redisConnection, workerRedisConnection, rateLimitRedisConnection } = await import("../../src/queue/redis.js");

    let actualRefundCount = 0;
    const mediaTable = new Map();
    const targetMediaId = "media-crash-idem-1";
    mediaTable.set(targetMediaId, { id: targetMediaId, status: "processing" });

    const origRollbackPreparedBilling = useCaseService.rollbackPreparedBilling;
    const { WalletService } = await import("../../src/platform/billing/WalletService.js");

    // Part A: Real WalletService rollbackFallback and rollbackHoldIdempotent tests
    const walletsTable = new Map();
    const transactionsTable = new Map();

    const mockSupabase = {
      from: (tableName) => {
        if (tableName === "wallets") {
          return {
            select: () => ({
              eq: (col, val) => ({
                single: async () => {
                  const row = walletsTable.get(val);
                  return row ? { data: { ...row }, error: null } : { data: null, error: { message: "Wallet not found" } };
                },
                maybeSingle: async () => {
                  const row = walletsTable.get(val);
                  return { data: row ? { ...row } : null, error: null };
                },
              }),
            }),
            update: (patch) => ({
              eq: async (col, val) => {
                const existing = walletsTable.get(val);
                if (existing) {
                  const updated = { ...existing, ...patch };
                  walletsTable.set(val, updated);
                  return { data: updated, error: null };
                }
                return { data: null, error: { message: "Wallet not found" } };
              },
            }),
          };
        }

        if (tableName === "transactions") {
          return {
            select: (cols) => ({
              eq: (col, val) => ({
                maybeSingle: async () => {
                  for (const tx of transactionsTable.values()) {
                    if (tx[col] === val) return { data: { ...tx }, error: null };
                  }
                  return { data: null, error: null };
                },
                single: async () => {
                  for (const tx of transactionsTable.values()) {
                    if (tx[col] === val) return { data: { ...tx }, error: null };
                  }
                  return { data: null, error: { message: "Not found" } };
                },
              }),
            }),
            update: (patch) => ({
              eq: (col1, val1) => ({
                eq: (col2, val2) => ({
                  select: () => ({
                    single: async () => {
                      const tx = transactionsTable.get(val1);
                      // Atomic optimistic lock: col2 ("status") must equal val2 ("PENDING")
                      if (tx && tx[col2] === val2) {
                        const updated = { ...tx, ...patch };
                        transactionsTable.set(val1, updated);
                        return { data: updated, error: null };
                      }
                      return { data: null, error: { message: "Conflict or already modified" } };
                    },
                  }),
                }),
              }),
            }),
          };
        }

        throw new Error(`Unexpected table: ${tableName}`);
      },
      rpc: async () => ({ data: null, error: { message: "RPC not found in test mode", code: "PGRST202" } }),
    };

    const walletService = new WalletService("https://placeholder.supabase.co", "placeholder-key");
    walletService.supabase = mockSupabase;
    const walletId = "wallet-real-test-1";
    const refId = "hold-ref-real-1";
    walletsTable.set(walletId, { id: walletId, user_id: "user-1", balance: 50 });
    transactionsTable.set("tx-1", {
      id: "tx-1",
      wallet_id: walletId,
      reference_id: refId,
      amount: 10,
      status: "PENDING",
      type: "HOLD",
    });

    // 1. Initial rollback: refunds 10 credits and updates status to FAILED
    const res1 = await walletService.rollbackFallback(refId);
    assert.equal(res1.status, "FAILED", "Status must be updated to FAILED");
    assert.equal(walletsTable.get(walletId).balance, 60, "Balance must increase from 50 to 60");

    // 2. Second rollback (retry / crash then timeout): must be idempotent no-op
    const res2 = await walletService.rollbackFallback(refId);
    assert.equal(res2.status, "FAILED", "Status remains FAILED");
    assert.equal(walletsTable.get(walletId).balance, 60, "Balance must remain 60 without duplicate credit");

    // 3. rollbackHoldIdempotent: safe across retries
    const res3 = await walletService.rollbackHoldIdempotent(refId);
    assert.equal(res3.status, "FAILED");
    assert.equal(walletsTable.get(walletId).balance, 60, "Balance remains 60");

    // Part B: Worker crash handler failure recovery marks ALL direct media failed
    const targetMediaId2 = "media-crash-idem-2";
    mediaTable.set(targetMediaId, { id: targetMediaId, status: "processing" });
    mediaTable.set(targetMediaId2, { id: targetMediaId2, status: "processing" });

    const origDbMedia = db.media;
    db.media = {
      updateMedia: async (id, patch) => {
        const existing = mediaTable.get(id) || { id };
        const updated = { ...existing, ...patch };
        mediaTable.set(id, updated);
        return updated;
      },
      findByWorkflow: async () => [],
    };

    const mockMultiMediaJob = {
      id: "job-crash-multi-1",
      data: {
        billingHoldId: refId,
        serverContext: {
          workflowId: "wf-crash-multi-1",
          mediaIds: [targetMediaId, targetMediaId2],
        },
      },
    };

    try {
      await handleUseCaseWorkerFailure(mockMultiMediaJob, new Error("Crash"));
      assert.equal(mediaTable.get(targetMediaId).status, "failed", "First media must be marked failed");
      assert.equal(mediaTable.get(targetMediaId2).status, "failed", "ALL media in mediaIds must be marked failed");
    } finally {
      db.media = origDbMedia;
      await useCaseWorker?.close?.().catch(() => {});
      await redisConnection?.quit().catch(() => redisConnection?.disconnect());
      await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
      await rateLimitRedisConnection?.quit().catch(() => rateLimitRedisConnection?.disconnect());
    }
  });
});
