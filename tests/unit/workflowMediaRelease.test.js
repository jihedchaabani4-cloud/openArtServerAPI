import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { WorkflowMediaService } from "../../src/platform/workflow/WorkflowMediaService.js";
import { WorkflowService } from "../../src/platform/workflow/WorkflowServiceBase.js";

function createHarness() {
  const mediaRows = [
    { id: "m-exclusive", url: "https://cdn.example/exclusive.png" },
    { id: "m-shared", url: "https://cdn.example/shared.png" },
  ];
  const relationRows = [
    { workflow_id: "wf-1", media_id: "m-exclusive", role: "output" },
    { workflow_id: "wf-1", media_id: "m-shared", role: "output" },
    { workflow_id: "wf-2", media_id: "m-shared", role: "input" },
  ];
  const workflows = [
    { id: "wf-1", project_id: "proj-1", primary_media_id: "m-exclusive", folder_id: "folder-1" },
    { id: "wf-3", project_id: "proj-1", primary_media_id: null, folder_id: "folder-1-child" },
    { id: "wf-keep", project_id: "proj-1", primary_media_id: null, folder_id: "folder-other" },
  ];
  const deletedStorageUrls = [];
  const deletedMediaIds = [];
  const deletedWorkflowIds = [];

  const db = {
    media: {
      findByWorkflow: async (workflowId) => {
        const linkedIds = new Set(
          relationRows.filter((r) => r.workflow_id === workflowId).map((r) => r.media_id)
        );
        return mediaRows.filter((m) => linkedIds.has(m.id));
      },
      findById: async (id) => mediaRows.find((m) => m.id === id) || null,
      updateFields: async (id, fields) => {
        const row = mediaRows.find((m) => m.id === id);
        if (!row) return null;
        Object.assign(row, fields);
        return row;
      },
      deleteById: async (id) => {
        const idx = mediaRows.findIndex((m) => m.id === id);
        if (idx === -1) return null;
        deletedMediaIds.push(id);
        const [removed] = mediaRows.splice(idx, 1);
        return removed;
      },
      client: () => ({
        from: () => ({
          delete: () => ({
            eq: async () => ({ error: null }),
          }),
        }),
      }),
    },
    workflowMedia: {
      unlinkByWorkflow: async (workflowId) => {
        for (let i = relationRows.length - 1; i >= 0; i -= 1) {
          if (relationRows[i].workflow_id === workflowId) relationRows.splice(i, 1);
        }
      },
      unlinkByMedia: async (mediaId) => {
        for (let i = relationRows.length - 1; i >= 0; i -= 1) {
          if (relationRows[i].media_id === mediaId) relationRows.splice(i, 1);
        }
      },
      countLinksForMedia: async (mediaId) =>
        relationRows.filter((r) => r.media_id === mediaId).length,
      findByMedia: async (mediaId) => relationRows.filter((r) => r.media_id === mediaId),
    },
    workflows: {
      findById: async (id) => workflows.find((w) => w.id === id) || null,
      updateFields: async (id, fields) => {
        const row = workflows.find((w) => w.id === id);
        if (!row) return null;
        Object.assign(row, fields);
        return row;
      },
      updatePrimaryMedia: async (id, mediaId) => {
        const row = workflows.find((w) => w.id === id);
        if (!row) return null;
        row.primary_media_id = mediaId;
        return row;
      },
      listIdsByFolderIds: async ({ folderIds, projectId } = {}) =>
        workflows
          .filter((w) => (!projectId || w.project_id === projectId) && folderIds?.includes(w.folder_id))
          .map((w) => w.id),
      deleteById: async (id) => {
        deletedWorkflowIds.push(id);
        const idx = workflows.findIndex((w) => w.id === id);
        if (idx !== -1) workflows.splice(idx, 1);
      },
      client: () => ({
        from: () => ({
          select: () => ({
            in: async () => ({ data: workflows, error: null }),
          }),
        }),
      }),
    },
  };

  const storageService = {
    deleteByUrl: async (url) => {
      deletedStorageUrls.push(url);
      return { ok: true };
    },
    deleteByUrls: async (urls) => {
      deletedStorageUrls.push(...urls);
      return { failures: [] };
    },
  };

  const mediaService = new WorkflowMediaService({
    db,
    storageService,
    authService: {
      verifyWorkflowOwnership: async () => true,
      verifyWorkflowOwnershipBulk: async (ids) => ids,
      verifyMediaOwnership: async () => true,
    },
  });

  const workflowService = new WorkflowService({
    db,
    storageService,
    mediaService,
    authService: {
      verifyWorkflowOwnership: async () => true,
      verifyWorkflowOwnershipBulk: async (ids) => ids,
      verifyMediaOwnership: async () => true,
    },
  });

  return {
    db,
    mediaRows,
    relationRows,
    mediaService,
    workflowService,
    deletedStorageUrls,
    deletedMediaIds,
    deletedWorkflowIds,
  };
}

describe("Workflow media unlink vs delete", () => {
  let harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it("deleteWorkflow unlinks media and only deletes orphans with no remaining workflow", async () => {
    const result = await harness.workflowService.deleteWorkflow({
      workflowId: "wf-1",
      userId: "user-1",
    });

    assert.equal(harness.deletedWorkflowIds.includes("wf-1"), true);
    assert.equal(harness.deletedMediaIds.includes("m-exclusive"), true);
    assert.equal(harness.deletedMediaIds.includes("m-shared"), false);
    assert.equal(harness.mediaRows.some((m) => m.id === "m-shared"), true);
    assert.equal(
      harness.relationRows.some((r) => r.media_id === "m-shared" && r.workflow_id === "wf-2"),
      true
    );
    assert.equal(harness.relationRows.some((r) => r.workflow_id === "wf-1"), false);
    assert.equal(harness.deletedStorageUrls.includes("https://cdn.example/exclusive.png"), true);
    assert.equal(harness.deletedStorageUrls.includes("https://cdn.example/shared.png"), false);
    assert.equal(result.deletedOrphanCount, 1);
    assert.equal(result.unlinkedMediaCount, 2);
  });

  it("deleteWorkflowsInFolders deletes owned workflows in those folders only", async () => {
    const result = await harness.workflowService.deleteWorkflowsInFolders({
      folderIds: ["folder-1", "folder-1-child"],
      userId: "user-1",
      projectId: "proj-1",
    });

    assert.equal(harness.deletedWorkflowIds.includes("wf-1"), true);
    assert.equal(harness.deletedWorkflowIds.includes("wf-3"), true);
    assert.equal(harness.deletedWorkflowIds.includes("wf-keep"), false);
    assert.equal(result.count, 2);
  });

  it("deleteMedia removes the media record and storage, not only the relation", async () => {
    const result = await harness.mediaService.deleteMedia({
      mediaId: "m-exclusive",
      userId: "user-1",
    });

    assert.equal(result.deleted, true);
    assert.equal(harness.deletedMediaIds.includes("m-exclusive"), true);
    assert.equal(harness.relationRows.some((r) => r.media_id === "m-exclusive"), false);
    assert.equal(harness.deletedStorageUrls.includes("https://cdn.example/exclusive.png"), true);
  });
});
