if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "test";
}

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { CharacterGenerationService } from "../../src/domain/character/CharacterGenerationService.js";
import { ElementService } from "../../src/domain/element/ElementService.js";
import { ElementMediaService } from "../../src/domain/element/ElementMediaService.js";
import { createWorkflowWithMediaAtomic } from "../../src/db/workflowMediaOps.js";
import { failWorkflowPendingMedia } from "../../src/platform/media/MediaLifecycleService.js";
import { supabase } from "../../lib/supabase.js";
import { setDb } from "../../src/platform/security/ownership.js";
import {
  setFallbackWorkflowMediaRepo,
  resetFallbackWorkflowMediaRepo,
} from "../../src/db/workflowMediaLinker.js";

describe("Sheet Generation real service layer tests — workflow_media integrity", () => {
  let originalRpc;

  beforeEach(() => {
    originalRpc = supabase.rpc;
  });

  afterEach(() => {
    supabase.rpc = originalRpc;
    setDb(null);
    resetFallbackWorkflowMediaRepo();
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
          characterId: "char-wf-fail-1",
          prompt: "Epic rogue",
          projectId: "proj-100",
          userId: "user-100",
          name: "Rogue",
        });
      },
      /Simulated foreign key constraint violation|Failed to link/
    );

    // Verify no orphaned media remains in "processing" status without a link
    const allMedia = Array.from(mediaTable.values());
    const orphanedProcessing = allMedia.filter(
      (m) => m.status === "processing" && !workflowMediaTable.some((wm) => wm.media_id === m.id)
    );
    assert.equal(orphanedProcessing.length, 0, "No media should remain in 'processing' without a workflow_media link");
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
    };

    // Spy on workflow_media links via the fallback workflowMedia repository
    setFallbackWorkflowMediaRepo({
      linkMedia: async ({ workflowId, mediaId, role, stepId }) => {
        const link = {
          workflow_id: workflowId,
          media_id: mediaId,
          role: role || (stepId === "element_sheet" ? "detail" : "detail"),
        };
        workflowMediaTable.push(link);
        return link;
      },
    });

    const elementMediaService = new ElementMediaService({
      db: dbWithoutWorkflowMedia,
      storageService: {},
      mediaIngestionService: {
        ingest: async ({ workflowId, stepId, source }) => {
          const media = await dbWithoutWorkflowMedia.media.createMedia({
            project_id: "proj-1",
            step_id: stepId,
            url: typeof source === "string" ? source : "https://cdn.example.com/element.png",
            status: "success",
          });
          const { createMediaInWorkflow } = await import("../../src/db/workflowMediaLinker.js");
          await createMediaInWorkflow(dbWithoutWorkflowMedia, {
            workflowId,
            mediaId: media.id,
            stepId,
            workflowType: "ELEMENT_SHEET",
          });
          return { media, url: media.url };
        },
      },
    });

    const elementService = new ElementService({
      db: dbWithoutWorkflowMedia,
      mediaService: elementMediaService,
      analysisService: { analyzeElement: async () => ({}) },
    });

    try {
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
    } finally {
      resetFallbackWorkflowMediaRepo();
    }
  });
});
