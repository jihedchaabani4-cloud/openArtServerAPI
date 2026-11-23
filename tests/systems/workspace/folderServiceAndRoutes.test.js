import { describe, it, beforeEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { indexById, indexChildren, getAncestorIds, getDepth, getSubtreeHeight, collectDescendantIds, wouldCreateCycle, wouldExceedDepth, depthForNewChild, FolderService, FolderError, FolderRepository } from "#workspace/tools";
import { MediaConflictError } from "#media/tools";
import express from "express";
import http from "node:http";
import apiRouter from "../../../src/api/routes.js";
import { db, folderService } from "../../../src/container.js";
import { supabase } from "#shared/db/supabase.js";
import { setLimiterForTest, resetLimitersForTest } from "#identity/tools";
import { redisConnection, workerRedisConnection, rateLimitRedisConnection } from "#shared";

// ─── Source: folderTree.test.js ───
{
describe("folderTree - pure tree logic (Task F-T1)", () => {
  // Setup standard dataset from section 7.4:
  // A (root), B (child of A), C (child of B), D (root)
  const sampleFolders = [
    { id: "A", parentId: null, name: "Folder A" },
    { id: "B", parentId: "A", name: "Folder B" },
    { id: "C", parentId: "B", name: "Folder C" },
    { id: "D", parentId: null, name: "Folder D" },
  ];

  const byId = indexById(sampleFolders);
  const children = indexChildren(sampleFolders);

  describe("indexById and indexChildren", () => {
    it("indexes folders by their ID", () => {
      assert.equal(byId.size, 4);
      assert.equal(byId.get("A").name, "Folder A");
      assert.equal(byId.get("C").parentId, "B");
    });

    it("indexes children by parentId with null as root key", () => {
      const roots = children.get(null);
      assert.equal(roots.length, 2);
      assert.deepEqual(roots.map((f) => f.id).sort(), ["A", "D"]);

      const aChildren = children.get("A");
      assert.equal(aChildren.length, 1);
      assert.equal(aChildren[0].id, "B");

      const bChildren = children.get("B");
      assert.equal(bChildren.length, 1);
      assert.equal(bChildren[0].id, "C");

      assert.equal(children.has("C"), false);
    });
  });

  describe("getDepth", () => {
    it("returns expected depths from test vector: A=1, B=2, C=3, D=1", () => {
      assert.equal(getDepth(byId, "A"), 1);
      assert.equal(getDepth(byId, "B"), 2);
      assert.equal(getDepth(byId, "C"), 3);
      assert.equal(getDepth(byId, "D"), 1);
    });

    it("returns 0 for non-existent folder id", () => {
      assert.equal(getDepth(byId, "UNKNOWN"), 0);
    });
  });

  describe("getSubtreeHeight", () => {
    it("returns expected subtree heights from test vector: A=3, B=2, C=1, D=1", () => {
      assert.equal(getSubtreeHeight(children, "A"), 3);
      assert.equal(getSubtreeHeight(children, "B"), 2);
      assert.equal(getSubtreeHeight(children, "C"), 1);
      assert.equal(getSubtreeHeight(children, "D"), 1);
    });

    it("returns 1 for a leaf or non-existent parent in children map", () => {
      assert.equal(getSubtreeHeight(children, "UNKNOWN"), 1);
    });
  });

  describe("getAncestorIds", () => {
    it("returns [B, A] for folder C", () => {
      assert.deepEqual(getAncestorIds(byId, "C"), ["B", "A"]);
    });

    it("returns [A] for folder B", () => {
      assert.deepEqual(getAncestorIds(byId, "B"), ["A"]);
    });

    it("returns [] for root folders A and D", () => {
      assert.deepEqual(getAncestorIds(byId, "A"), []);
      assert.deepEqual(getAncestorIds(byId, "D"), []);
    });

    it("throws an error when a cycle is detected in stored data", () => {
      // Data with loop: X parent is Y, Y parent is X
      const cyclicFolders = [
        { id: "X", parentId: "Y" },
        { id: "Y", parentId: "X" },
      ];
      const cyclicById = indexById(cyclicFolders);
      assert.throws(
        () => getAncestorIds(cyclicById, "X"),
        /cycle detected in stored data/i
      );
    });
  });

  describe("collectDescendantIds", () => {
    it("returns {A, B, C} for folder A", () => {
      const descendants = collectDescendantIds(children, "A");
      assert.deepEqual(Array.from(descendants).sort(), ["A", "B", "C"]);
    });

    it("returns {D} for folder D (leaf root)", () => {
      const descendants = collectDescendantIds(children, "D");
      assert.deepEqual(Array.from(descendants), ["D"]);
    });

    it("returns {C} for folder C (leaf)", () => {
      const descendants = collectDescendantIds(children, "C");
      assert.deepEqual(Array.from(descendants), ["C"]);
    });
  });

  describe("wouldCreateCycle", () => {
    it("wouldCreateCycle(moving=A, newParent=C) -> true", () => {
      assert.equal(wouldCreateCycle(byId, "A", "C"), true);
    });

    it("wouldCreateCycle(moving=A, newParent=B) -> true", () => {
      assert.equal(wouldCreateCycle(byId, "A", "B"), true);
    });

    it("wouldCreateCycle(moving=A, newParent=A) -> true (cannot parent to itself)", () => {
      assert.equal(wouldCreateCycle(byId, "A", "A"), true);
    });

    it("wouldCreateCycle(moving=A, newParent=D) -> false", () => {
      assert.equal(wouldCreateCycle(byId, "A", "D"), false);
    });

    it("wouldCreateCycle(moving=C, newParent=A) -> false (moving C under A is valid)", () => {
      assert.equal(wouldCreateCycle(byId, "C", "A"), false);
    });

    it("wouldCreateCycle(moving=B, newParent=null) -> false (moving to root is valid)", () => {
      assert.equal(wouldCreateCycle(byId, "B", null), false);
    });
  });

  describe("wouldExceedDepth", () => {
    it("wouldExceedDepth(moving=D, newParent=C, max=3) -> true (3 + 1 > 3)", () => {
      assert.equal(wouldExceedDepth(byId, children, "D", "C", 3), true);
    });

    it("wouldExceedDepth(moving=D, newParent=B, max=3) -> false (2 + 1 = 3)", () => {
      assert.equal(wouldExceedDepth(byId, children, "D", "B", 3), false);
    });

    it("wouldExceedDepth(moving=A, newParent=D, max=3) -> true (1 + 3 > 3)", () => {
      assert.equal(wouldExceedDepth(byId, children, "A", "D", 3), true);
    });

    it("wouldExceedDepth(moving=A, newParent=null, max=3) -> false (0 + 3 = 3)", () => {
      assert.equal(wouldExceedDepth(byId, children, "A", null, 3), false);
    });
  });

  describe("depthForNewChild", () => {
    it("returns 1 when parentId is null (new root folder)", () => {
      assert.equal(depthForNewChild(byId, null), 1);
    });

    it("returns parentDepth + 1 for existing parent", () => {
      assert.equal(depthForNewChild(byId, "A"), 2);
      assert.equal(depthForNewChild(byId, "B"), 3);
      assert.equal(depthForNewChild(byId, "C"), 4);
    });
  });
});
}

// ─── Source: folderService.test.js ───
{
describe("FolderService Business Rules & Error Scenarios (Task F-T4)", () => {
  let foldersInDb;
  let workflowsInDb;
  let mockRepo;
  let service;

  beforeEach(() => {
    foldersInDb = [
      {
        id: "f-root-1",
        project_id: "proj-1",
        user_id: "user-1",
        parent_id: null,
        name: "Scene 1",
        position: 0,
        created_at: "2026-10-07T10:00:00.000Z",
        updated_at: "2026-10-07T10:00:00.000Z",
      },
      {
        id: "f-child-1",
        project_id: "proj-1",
        user_id: "user-1",
        parent_id: "f-root-1",
        name: "Shots",
        position: 0,
        created_at: "2026-10-07T10:00:00.000Z",
        updated_at: "2026-10-07T10:00:00.000Z",
      },
      {
        id: "f-leaf-1",
        project_id: "proj-1",
        user_id: "user-1",
        parent_id: "f-child-1",
        name: "Closeups",
        position: 0,
        created_at: "2026-10-07T10:00:00.000Z",
        updated_at: "2026-10-07T10:00:00.000Z",
      },
      {
        id: "f-root-2",
        project_id: "proj-1",
        user_id: "user-1",
        parent_id: null,
        name: "Audio",
        position: 1,
        created_at: "2026-10-07T10:00:00.000Z",
        updated_at: "2026-10-07T10:00:00.000Z",
      },
    ];

    workflowsInDb = [
      { id: "wf-1", folder_id: "f-root-1", project_id: "proj-1" },
      { id: "wf-2", folder_id: "f-root-1", project_id: "proj-1" },
      { id: "wf-3", folder_id: "f-child-1", project_id: "proj-1" },
    ];

    mockRepo = {
      listByProject: async (projectId, userId) => {
        return foldersInDb.filter((f) => f.project_id === projectId && f.user_id === userId);
      },
      findOwned: async (folderId, userId) => {
        return foldersInDb.find((f) => f.id === folderId && f.user_id === userId) || null;
      },
      findOwnedInProject: async (folderId, projectId, userId) => {
        return (
          foldersInDb.find(
            (f) => f.id === folderId && f.project_id === projectId && f.user_id === userId
          ) || null
        );
      },
      countByProject: async (projectId, userId) => {
        return foldersInDb.filter((f) => f.project_id === projectId && f.user_id === userId).length;
      },
      create: async ({ projectId, userId, parentId, name, color, description, position }) => {
        const newFolder = {
          id: `f-${Date.now()}-${Math.random()}`,
          project_id: projectId,
          user_id: userId,
          parent_id: parentId || null,
          name,
          color: color || null,
          description: description || null,
          position,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        foldersInDb.push(newFolder);
        return newFolder;
      },
      updateOwned: async (folderId, userId, patch) => {
        const folder = foldersInDb.find((f) => f.id === folderId && f.user_id === userId);
        if (!folder) return null;
        if (patch.name !== undefined) folder.name = patch.name;
        if (patch.color !== undefined) folder.color = patch.color;
        if (patch.description !== undefined) folder.description = patch.description;
        if (patch.parentId !== undefined) folder.parent_id = patch.parentId;
        if (patch.parent_id !== undefined) folder.parent_id = patch.parent_id;
        if (patch.position !== undefined) folder.position = patch.position;
        folder.updated_at = new Date().toISOString();
        return folder;
      },
      deleteOwned: async (folderId, userId) => {
        const idx = foldersInDb.findIndex((f) => f.id === folderId && f.user_id === userId);
        if (idx === -1) return false;
        foldersInDb.splice(idx, 1);
        return true;
      },
      countAssetsByFolder: async (projectId, userId) => {
        const map = {};
        for (const wf of workflowsInDb) {
          if (wf.folder_id) {
            map[wf.folder_id] = (map[wf.folder_id] || 0) + 1;
          }
        }
        return map;
      },
      countChildren: async (folderId, userId) => {
        return foldersInDb.filter((f) => f.parent_id === folderId && f.user_id === userId).length;
      },
      countAssetsIn: async (folderId, userId) => {
        return workflowsInDb.filter((wf) => wf.folder_id === folderId).length;
      },
    };

    service = new FolderService({
      folderRepo: mockRepo,
      maxDepth: 3,
      maxFoldersPerProject: 5,
    });
  });

  describe("Error Table Validations", () => {
    it("throws FOLDER_NAME_INVALID for empty or whitespace-only name", async () => {
      await assert.rejects(
        async () => {
          await service.create({ projectId: "proj-1", userId: "user-1", name: "   " });
        },
        (err) => {
          assert(err instanceof FolderError);
          assert.equal(err.errorCode, "FOLDER_NAME_INVALID");
          assert.equal(err.statusCode, 400);
          return true;
        }
      );
    });

    it("throws FOLDER_NAME_INVALID for names longer than 100 characters", async () => {
      const longName = "A".repeat(101);
      await assert.rejects(
        async () => {
          await service.create({ projectId: "proj-1", userId: "user-1", name: longName });
        },
        (err) => {
          assert.equal(err.errorCode, "FOLDER_NAME_INVALID");
          assert.equal(err.statusCode, 400);
          return true;
        }
      );
    });

    it("throws FOLDER_NAME_TAKEN when sibling name already exists in same parent (case-insensitive)", async () => {
      await assert.rejects(
        async () => {
          await service.create({
            projectId: "proj-1",
            userId: "user-1",
            parentId: null,
            name: "scene 1", // Matches "Scene 1" case-insensitively
          });
        },
        (err) => {
          assert.equal(err.errorCode, "FOLDER_NAME_TAKEN");
          assert.equal(err.statusCode, 409);
          return true;
        }
      );
    });

    it("throws FOLDER_CYCLE when moving folder into itself or its descendant", async () => {
      await assert.rejects(
        async () => {
          // Move f-root-1 under its child f-child-1
          await service.update({
            folderId: "f-root-1",
            userId: "user-1",
            patch: { parentId: "f-child-1" },
          });
        },
        (err) => {
          assert.equal(err.errorCode, "FOLDER_CYCLE");
          assert.equal(err.statusCode, 400);
          return true;
        }
      );
    });

    it("throws FOLDER_DEPTH_EXCEEDED when creating a folder exceeding maxDepth", async () => {
      // Current tree: f-root-1 (1) -> f-child-1 (2) -> f-leaf-1 (3). Max depth is 3.
      await assert.rejects(
        async () => {
          await service.create({
            projectId: "proj-1",
            userId: "user-1",
            parentId: "f-leaf-1",
            name: "Exceeds Depth",
          });
        },
        (err) => {
          assert.equal(err.errorCode, "FOLDER_DEPTH_EXCEEDED");
          assert.equal(err.statusCode, 400);
          return true;
        }
      );
    });

    it("throws FOLDER_LIMIT_REACHED when project reaches maxFoldersPerProject", async () => {
      // Add one more to reach limit (5)
      foldersInDb.push({
        id: "f-extra",
        project_id: "proj-1",
        user_id: "user-1",
        parent_id: null,
        name: "Extra",
        position: 4,
      });

      await assert.rejects(
        async () => {
          await service.create({
            projectId: "proj-1",
            userId: "user-1",
            name: "Beyond Limit",
          });
        },
        (err) => {
          assert.equal(err.errorCode, "FOLDER_LIMIT_REACHED");
          assert.equal(err.statusCode, 400);
          return true;
        }
      );
    });

    it("moves nested folder tree workflows to Trash, unlinks folder_id, and deletes folders deepest-first", async () => {
      const callOrder = [];
      const trashRows = new Map();
      const deletedFolderIds = [];

      const trackingFolderRepo = {
        ...mockRepo,
        deleteOwned: async (folderId, userId) => {
          callOrder.push(`deleteFolder:${folderId}`);
          deletedFolderIds.push(folderId);
          return mockRepo.deleteOwned(folderId, userId);
        },
      };

      service = new FolderService({
        folderRepo: trackingFolderRepo,
        maxDepth: 3,
        maxFoldersPerProject: 5,
        trashRepo: {
          insertManyIfAbsent: async ({ workflowIds, userId, deletedBy }) => {
            callOrder.push(`trash:${workflowIds.slice().sort().join(",")}`);
            const inserted = [];
            for (const workflowId of workflowIds) {
              if (!trashRows.has(workflowId)) {
                const row = {
                  workflow_id: workflowId,
                  user_id: userId,
                  deleted_by: deletedBy,
                  deleted_at: "2026-11-21T00:00:00.000Z",
                };
                trashRows.set(workflowId, row);
                inserted.push(row);
              }
            }
            return inserted;
          },
        },
        workflowService: {
          listOwnedWorkflowIdsInFolders: async ({ folderIds, projectId }) => {
            callOrder.push("listOwnedWorkflows");
            return workflowsInDb
              .filter((wf) => folderIds.includes(wf.folder_id) && wf.project_id === projectId)
              .map((wf) => wf.id);
          },
          unlinkWorkflowsFromFolders: async ({ workflowIds, folderIds, projectId }) => {
            callOrder.push(`unlink:${workflowIds.slice().sort().join(",")}`);
            const unlinked = [];
            for (const wf of workflowsInDb) {
              if (
                workflowIds.includes(wf.id) &&
                folderIds.includes(wf.folder_id) &&
                wf.project_id === projectId
              ) {
                wf.folder_id = null;
                unlinked.push(wf.id);
              }
            }
            return { workflow_ids: unlinked, count: unlinked.length };
          },
        },
      });

      const res = await service.remove({ folderId: "f-root-1", userId: "user-1" });
      assert.equal(res, true);

      // Folders deleted deepest-first, sibling folder untouched
      assert.deepEqual(deletedFolderIds, ["f-leaf-1", "f-child-1", "f-root-1"]);
      assert.equal(foldersInDb.some((f) => f.id === "f-root-1"), false);
      assert.equal(foldersInDb.some((f) => f.id === "f-child-1"), false);
      assert.equal(foldersInDb.some((f) => f.id === "f-leaf-1"), false);
      assert.equal(foldersInDb.some((f) => f.id === "f-root-2"), true);

      // Workflows preserved (NOT permanently deleted), trashed, and unlinked to project root
      assert.deepEqual(workflowsInDb.map((w) => w.id).sort(), ["wf-1", "wf-2", "wf-3"]);
      assert.equal(workflowsInDb.every((w) => w.folder_id === null), true);
      assert.deepEqual([...trashRows.keys()].sort(), ["wf-1", "wf-2", "wf-3"]);

      // Strict ordering: verify ownership -> insert into trash -> clear folder_id -> delete folders deepest-first
      assert.deepEqual(callOrder, [
        "listOwnedWorkflows",
        "trash:wf-1,wf-2,wf-3",
        "unlink:wf-1,wf-2,wf-3",
        "deleteFolder:f-leaf-1",
        "deleteFolder:f-child-1",
        "deleteFolder:f-root-1",
      ]);
    });

    it("preserves already-trashed workflows (original deleted_at intact), unlinks folder_id, and deletes folder", async () => {
      const originalDeletedAt = "2026-10-01T12:00:00.000Z";
      const trashRows = new Map([
        [
          "wf-1",
          {
            workflow_id: "wf-1",
            user_id: "user-1",
            deleted_by: "user-1",
            deleted_at: originalDeletedAt,
          },
        ],
      ]);
      let permanentDeleteCalled = false;

      service = new FolderService({
        folderRepo: mockRepo,
        maxDepth: 3,
        maxFoldersPerProject: 5,
        trashRepo: {
          insertManyIfAbsent: async ({ workflowIds, userId, deletedBy }) => {
            const inserted = [];
            for (const workflowId of workflowIds) {
              if (!trashRows.has(workflowId)) {
                const row = {
                  workflow_id: workflowId,
                  user_id: userId,
                  deleted_by: deletedBy,
                  deleted_at: "2026-11-21T00:00:00.000Z",
                };
                trashRows.set(workflowId, row);
                inserted.push(row);
              }
            }
            return inserted;
          },
        },
        workflowService: {
          deleteWorkflow: async () => {
            permanentDeleteCalled = true;
          },
          listOwnedWorkflowIdsInFolders: async ({ folderIds, projectId }) =>
            workflowsInDb
              .filter((wf) => folderIds.includes(wf.folder_id) && wf.project_id === projectId)
              .map((wf) => wf.id),
          unlinkWorkflowsFromFolders: async ({ workflowIds, folderIds, projectId }) => {
            for (const wf of workflowsInDb) {
              if (
                workflowIds.includes(wf.id) &&
                folderIds.includes(wf.folder_id) &&
                wf.project_id === projectId
              ) {
                wf.folder_id = null;
              }
            }
            return { workflow_ids: workflowIds, count: workflowIds.length };
          },
        },
      });

      const res = await service.remove({ folderId: "f-root-1", userId: "user-1" });
      assert.equal(res, true);
      assert.equal(permanentDeleteCalled, false);
      assert.equal(trashRows.get("wf-1").deleted_at, originalDeletedAt);
      assert.equal(trashRows.has("wf-2"), true);
      assert.equal(trashRows.has("wf-3"), true);
      assert.equal(workflowsInDb.every((w) => w.folder_id === null), true);
      assert.equal(workflowsInDb.length, 3);
    });

    it("deletes empty folder and nested empty subfolders directly with zero trash inserts", async () => {
      foldersInDb.push({
        id: "f-root-2-child",
        project_id: "proj-1",
        user_id: "user-1",
        parent_id: "f-root-2",
        name: "Empty Sub",
        position: 0,
      });

      let trashInsertCalls = 0;
      let unlinkCalls = 0;
      const deletedOrder = [];

      service = new FolderService({
        folderRepo: {
          ...mockRepo,
          deleteOwned: async (folderId, userId) => {
            deletedOrder.push(folderId);
            return mockRepo.deleteOwned(folderId, userId);
          },
        },
        trashRepo: {
          insertManyIfAbsent: async () => {
            trashInsertCalls += 1;
            return [];
          },
        },
        workflowService: {
          listOwnedWorkflowIdsInFolders: async ({ folderIds, projectId }) =>
            workflowsInDb
              .filter((wf) => folderIds.includes(wf.folder_id) && wf.project_id === projectId)
              .map((wf) => wf.id),
          unlinkWorkflowsFromFolders: async () => {
            unlinkCalls += 1;
            return { workflow_ids: [], count: 0 };
          },
        },
      });

      const res = await service.remove({ folderId: "f-root-2", userId: "user-1" });
      assert.equal(res, true);
      assert.equal(trashInsertCalls, 0);
      assert.equal(unlinkCalls, 0);
      assert.deepEqual(deletedOrder, ["f-root-2-child", "f-root-2"]);
    });

    it("aborts without deleting folders if ownership verification, trash insert, or unlinking fails", async () => {
      // Case A: Ownership verification fails before any mutation
      let trashCalls = 0;
      let unlinkCalls = 0;
      let deleteCalls = 0;

      const makeGuardedFolderRepo = () => ({
        ...mockRepo,
        deleteOwned: async (folderId, userId) => {
          deleteCalls += 1;
          return mockRepo.deleteOwned(folderId, userId);
        },
      });

      const authFailService = new FolderService({
        folderRepo: makeGuardedFolderRepo(),
        trashRepo: {
          insertManyIfAbsent: async () => {
            trashCalls += 1;
            return [];
          },
        },
        workflowService: {
          listOwnedWorkflowIdsInFolders: async () => {
            const err = new Error("Workflow not found");
            err.statusCode = 404;
            err.errorCode = "NOT_FOUND";
            throw err;
          },
          unlinkWorkflowsFromFolders: async () => {
            unlinkCalls += 1;
          },
        },
      });

      await assert.rejects(
        () => authFailService.remove({ folderId: "f-root-1", userId: "user-1" }),
        { statusCode: 404 }
      );
      assert.equal(trashCalls, 0);
      assert.equal(unlinkCalls, 0);
      assert.equal(deleteCalls, 0);
      assert.equal(foldersInDb.some((f) => f.id === "f-root-1"), true);

      // Case B: Trash insertion fails -> no unlink, no folder delete
      const trashFailService = new FolderService({
        folderRepo: makeGuardedFolderRepo(),
        trashRepo: {
          insertManyIfAbsent: async () => {
            throw new Error("DB trash insert failed");
          },
        },
        workflowService: {
          listOwnedWorkflowIdsInFolders: async () => ["wf-1", "wf-2", "wf-3"],
          unlinkWorkflowsFromFolders: async () => {
            unlinkCalls += 1;
          },
        },
      });

      await assert.rejects(
        () => trashFailService.remove({ folderId: "f-root-1", userId: "user-1" }),
        /DB trash insert failed/
      );
      assert.equal(unlinkCalls, 0);
      assert.equal(deleteCalls, 0);
      assert.equal(workflowsInDb.find((w) => w.id === "wf-1").folder_id, "f-root-1");
      assert.equal(foldersInDb.some((f) => f.id === "f-root-1"), true);

      // Case C: Clearing folder_id fails -> no folder delete
      const unlinkFailService = new FolderService({
        folderRepo: makeGuardedFolderRepo(),
        trashRepo: {
          insertManyIfAbsent: async () => [{ workflow_id: "wf-1" }],
        },
        workflowService: {
          listOwnedWorkflowIdsInFolders: async () => ["wf-1", "wf-2", "wf-3"],
          unlinkWorkflowsFromFolders: async () => {
            throw new Error("DB unlink failed");
          },
        },
      });

      await assert.rejects(
        () => unlinkFailService.remove({ folderId: "f-root-1", userId: "user-1" }),
        /DB unlink failed/
      );
      assert.equal(deleteCalls, 0);
      assert.equal(foldersInDb.some((f) => f.id === "f-root-1"), true);
      assert.equal(foldersInDb.some((f) => f.id === "f-leaf-1"), true);
    });

    it("rejects folder deletion with 409 MEDIA_PROCESSING and zero mutations when any workflow in subtree has processing or pending media", async () => {
      let trashCalls = 0;
      let unlinkCalls = 0;
      let deleteWfCalls = 0;
      let deleteFolderCalls = 0;

      const mediaStatusService = new FolderService({
        folderRepo: {
          ...mockRepo,
          deleteOwned: async (folderId, userId) => {
            deleteFolderCalls += 1;
            return mockRepo.deleteOwned(folderId, userId);
          },
        },
        trashRepo: {
          insertManyIfAbsent: async () => {
            trashCalls += 1;
            return [];
          },
        },
        workflowMediaRepo: {
          findMediaStatusesByWorkflowIds: async () =>
            new Map([
              ["wf-1", [{ id: "m-1", status: "completed", url: "https://cdn/1.png" }]],
              ["wf-2", [{ id: "m-2", status: "failed", url: null }]],
              ["wf-3", [{ id: "m-3", status: "processing", url: null }]],
            ]),
        },
        workflowService: {
          listOwnedWorkflowIdsInFolders: async ({ folderIds, projectId }) =>
            workflowsInDb
              .filter((wf) => folderIds.includes(wf.folder_id) && wf.project_id === projectId)
              .map((wf) => wf.id),
          unlinkWorkflowsFromFolders: async () => {
            unlinkCalls += 1;
            return { workflow_ids: [], count: 0 };
          },
          deleteWorkflow: async () => {
            deleteWfCalls += 1;
          },
        },
      });

      await assert.rejects(
        () => mediaStatusService.remove({ folderId: "f-root-1", userId: "user-1" }),
        (err) => {
          assert.ok(err instanceof MediaConflictError);
          assert.equal(err.statusCode, 409);
          assert.equal(err.errorCode, "MEDIA_PROCESSING");
          return true;
        }
      );

      assert.equal(trashCalls, 0);
      assert.equal(unlinkCalls, 0);
      assert.equal(deleteWfCalls, 0);
      assert.equal(deleteFolderCalls, 0);
      assert.equal(foldersInDb.some((f) => f.id === "f-root-1"), true);
      assert.equal(workflowsInDb.find((w) => w.id === "wf-3").folder_id, "f-child-1");
    });

    it("hard-deletes failed-only workflows directly (never trashing them) while trashing completed and mixed (failed + completed) workflows during folder deletion", async () => {
      const trashedIds = [];
      const unlinkedIds = [];
      const hardDeletedIds = [];
      const deletedFolderIds = [];

      const mixedFolderService = new FolderService({
        folderRepo: {
          ...mockRepo,
          deleteOwned: async (folderId, userId) => {
            deletedFolderIds.push(folderId);
            return mockRepo.deleteOwned(folderId, userId);
          },
        },
        trashRepo: {
          insertManyIfAbsent: async ({ workflowIds }) => {
            trashedIds.push(...workflowIds);
            return workflowIds.map((id) => ({ workflow_id: id }));
          },
        },
        workflowMediaRepo: {
          findMediaStatusesByWorkflowIds: async () =>
            new Map([
              ["wf-1", [{ id: "m-1", status: "completed", url: "https://cdn/1.png" }]],
              ["wf-2", [{ id: "m-2", status: "failed", url: null }]],
              [
                "wf-3",
                [
                  { id: "m-3a", status: "failed", url: null },
                  { id: "m-3b", status: "success", url: "https://cdn/3.png" },
                ],
              ],
            ]),
        },
        workflowService: {
          listOwnedWorkflowIdsInFolders: async ({ folderIds, projectId }) =>
            workflowsInDb
              .filter((wf) => folderIds.includes(wf.folder_id) && wf.project_id === projectId)
              .map((wf) => wf.id),
          unlinkWorkflowsFromFolders: async ({ workflowIds }) => {
            unlinkedIds.push(...workflowIds);
            for (const wf of workflowsInDb) {
              if (workflowIds.includes(wf.id)) wf.folder_id = null;
            }
            return { workflow_ids: workflowIds, count: workflowIds.length };
          },
          deleteWorkflow: async ({ workflowId }) => {
            hardDeletedIds.push(workflowId);
            const idx = workflowsInDb.findIndex((w) => w.id === workflowId);
            if (idx !== -1) workflowsInDb.splice(idx, 1);
            return { workflowId, deletedMediaCount: 1 };
          },
        },
      });

      const ok = await mixedFolderService.remove({ folderId: "f-root-1", userId: "user-1" });
      assert.equal(ok, true);
      assert.deepEqual(trashedIds.slice().sort(), ["wf-1", "wf-3"], "Completed and mixed workflows must be trashed, NOT failed-only wf-2");
      assert.deepEqual(unlinkedIds.slice().sort(), ["wf-1", "wf-3"]);
      assert.deepEqual(hardDeletedIds, ["wf-2"], "Failed-only wf-2 must be directly hard-deleted");
      assert.deepEqual(deletedFolderIds, ["f-leaf-1", "f-child-1", "f-root-1"]);
    });

    it("delegates failed-only character/element workflows inside a deleted folder to permanentDeleteWorkflow (canonical owner cleanup, zero orphan sidecars)", async () => {
      const characters = [{ id: "char-1", workflow_id: "wf-2" }];
      const elements = [{ id: "elem-1", workflow_id: "wf-3" }];
      const ownerDeletes = [];
      let rawDeleteWorkflowCalls = 0;
      const trashedIds = [];

      const ownerAwareService = new FolderService({
        folderRepo: mockRepo,
        trashRepo: {
          insertManyIfAbsent: async ({ workflowIds }) => {
            trashedIds.push(...workflowIds);
            return workflowIds.map((id) => ({ workflow_id: id }));
          },
        },
        workflowMediaRepo: {
          findMediaStatusesByWorkflowIds: async () =>
            new Map([
              ["wf-1", [{ id: "m-1", status: "completed", url: "https://cdn/1.png" }]],
              ["wf-2", [{ id: "m-2", status: "failed", url: null }]],
              ["wf-3", [{ id: "m-3", status: "failed", url: null }]],
            ]),
        },
        workflowService: {
          listOwnedWorkflowIdsInFolders: async ({ folderIds, projectId }) =>
            workflowsInDb
              .filter((wf) => folderIds.includes(wf.folder_id) && wf.project_id === projectId)
              .map((wf) => wf.id),
          unlinkWorkflowsFromFolders: async ({ workflowIds }) => {
            for (const wf of workflowsInDb) {
              if (workflowIds.includes(wf.id)) wf.folder_id = null;
            }
            return { workflow_ids: workflowIds, count: workflowIds.length };
          },
          deleteWorkflow: async () => {
            rawDeleteWorkflowCalls += 1;
          },
        },
        permanentDeleteWorkflow: async ({ workflowId, userId }) => {
          ownerDeletes.push({ workflowId, userId });
          const cIdx = characters.findIndex((c) => c.workflow_id === workflowId);
          if (cIdx !== -1) characters.splice(cIdx, 1);
          const eIdx = elements.findIndex((e) => e.workflow_id === workflowId);
          if (eIdx !== -1) elements.splice(eIdx, 1);
          const wIdx = workflowsInDb.findIndex((w) => w.id === workflowId);
          if (wIdx !== -1) workflowsInDb.splice(wIdx, 1);
        },
      });

      const ok = await ownerAwareService.remove({ folderId: "f-root-1", userId: "user-1" });
      assert.equal(ok, true);
      assert.equal(rawDeleteWorkflowCalls, 0, "Must use owner-aware permanentDeleteWorkflow instead of bare workflowService.deleteWorkflow");
      assert.deepEqual(ownerDeletes.map((d) => d.workflowId).sort(), ["wf-2", "wf-3"]);
      assert.equal(characters.length, 0, "Character sidecar row must be cleaned up (no orphan)");
      assert.equal(elements.length, 0, "Element sidecar row must be cleaned up (no orphan)");
      assert.deepEqual(trashedIds, ["wf-1"]);
      assert.equal(foldersInDb.some((f) => f.id === "f-root-1"), false);
    });

    it("checks failed-only delete capability upfront before any trash or unlink mutations (pre-flight atomicity)", async () => {
      let trashCalls = 0;
      let unlinkCalls = 0;
      let deleteFolderCalls = 0;

      const missingDeleteService = new FolderService({
        folderRepo: {
          ...mockRepo,
          deleteOwned: async () => {
            deleteFolderCalls += 1;
            return true;
          },
        },
        trashRepo: {
          insertManyIfAbsent: async () => {
            trashCalls += 1;
            return [];
          },
        },
        workflowMediaRepo: {
          findMediaStatusesByWorkflowIds: async () =>
            new Map([
              ["wf-1", [{ id: "m-1", status: "completed", url: "https://cdn/1.png" }]],
              ["wf-2", [{ id: "m-2", status: "failed", url: null }]],
              ["wf-3", [{ id: "m-3", status: "completed", url: "https://cdn/3.png" }]],
            ]),
        },
        workflowService: {
          listOwnedWorkflowIdsInFolders: async ({ folderIds, projectId }) =>
            workflowsInDb
              .filter((wf) => folderIds.includes(wf.folder_id) && wf.project_id === projectId)
              .map((wf) => wf.id),
          unlinkWorkflowsFromFolders: async () => {
            unlinkCalls += 1;
            return { workflow_ids: [], count: 0 };
          },
        },
      });

      await assert.rejects(
        () => missingDeleteService.remove({ folderId: "f-root-1", userId: "user-1" }),
        (err) => err.statusCode === 500 && err.errorCode === "WORKFLOW_DELETE_UNAVAILABLE"
      );
      assert.equal(trashCalls, 0, "Zero trash writes when pre-flight fails");
      assert.equal(unlinkCalls, 0, "Zero unlinks when pre-flight fails");
      assert.equal(deleteFolderCalls, 0, "Zero folder deletes when pre-flight fails");
      assert.equal(workflowsInDb.find((w) => w.id === "wf-1").folder_id, "f-root-1");
    });

    it("throws NOT_FOUND when updating or removing an unknown or foreign folder", async () => {
      await assert.rejects(
        async () => {
          await service.update({
            folderId: "f-root-1",
            userId: "user-B", // foreign user
            patch: { name: "Hijacked" },
          });
        },
        (err) => {
          assert.equal(err.errorCode, "NOT_FOUND");
          assert.equal(err.statusCode, 404);
          return true;
        }
      );

      await assert.rejects(
        async () => {
          await service.remove({ folderId: "unknown-id", userId: "user-1" });
        },
        (err) => {
          assert.equal(err.errorCode, "NOT_FOUND");
          assert.equal(err.statusCode, 404);
          return true;
        }
      );
    });
  });

  describe("Happy Path Operations", () => {
    it("list returns flat folder list with asset counts", async () => {
      const res = await service.list({ projectId: "proj-1", userId: "user-1" });
      assert(Array.isArray(res.items));
      assert.equal(res.items.length, 4);

      const root1 = res.items.find((f) => f.id === "f-root-1");
      assert.equal(root1.assetCount, 2);

      const audio = res.items.find((f) => f.id === "f-root-2");
      assert.equal(audio.assetCount, 0);
    });

    it("create succeeds and assigns position = largest sibling position + 1", async () => {
      const created = await service.create({
        projectId: "proj-1",
        userId: "user-1",
        parentId: null,
        name: "New Root",
      });

      assert.equal(created.name, "New Root");
      assert.equal(created.position, 2); // Previous roots had 0 and 1
    });

    it("create defaults to 'Untitled collection' when name is omitted or undefined", async () => {
      const created1 = await service.create({
        projectId: "proj-2",
        userId: "user-1",
        parentId: null,
      });

      assert.equal(created1.name, "Untitled collection");

      const created2 = await service.create({
        projectId: "proj-2",
        userId: "user-1",
        parentId: null,
      });

      assert.equal(created2.name, "Untitled collection 2");
    });

    it("update renames folder successfully", async () => {
      const updated = await service.update({
        folderId: "f-root-2",
        userId: "user-1",
        patch: { name: "Music and Audio" },
      });

      assert.equal(updated.name, "Music and Audio");
    });

    it("remove succeeds when folder is empty", async () => {
      const res = await service.remove({ folderId: "f-root-2", userId: "user-1" });
      assert.equal(res, true);
      assert.equal(foldersInDb.some((f) => f.id === "f-root-2"), false);
    });

    it("assertFolderUsable returns null for null folderId", async () => {
      const result = await service.assertFolderUsable(null, "user-1", "proj-1");
      assert.equal(result, null);
    });

    it("assertFolderUsable returns folder when valid and owned", async () => {
      const result = await service.assertFolderUsable("f-root-1", "user-1", "proj-1");
      assert.equal(result.id, "f-root-1");
    });

    it("create supports optional color and description", async () => {
      const created = await service.create({
        projectId: "proj-1",
        userId: "user-1",
        name: "Cyberpunk Art",
        color: "#9C27B0",
        description: "Neon aesthetic collection for cyberpunk characters",
      });
      assert.equal(created.name, "Cyberpunk Art");
      assert.equal(created.color, "#9C27B0");
      assert.equal(created.description, "Neon aesthetic collection for cyberpunk characters");
    });

    it("unified edit: updates only color when only color is provided", async () => {
      const updated = await service.update({
        folderId: "f-root-1",
        userId: "user-1",
        patch: { color: "#FF5722" },
      });
      assert.equal(updated.id, "f-root-1");
      assert.equal(updated.name, "Scene 1"); // Unchanged
      assert.equal(updated.color, "#FF5722");
    });

    it("unified edit: updates only description when only description is provided", async () => {
      const updated = await service.update({
        folderId: "f-root-1",
        userId: "user-1",
        patch: { description: "Main assets for scene 1 storyboard" },
      });
      assert.equal(updated.id, "f-root-1");
      assert.equal(updated.name, "Scene 1"); // Unchanged
      assert.equal(updated.description, "Main assets for scene 1 storyboard");
    });

    it("unified edit: updates multiple parameters in a single API call", async () => {
      const updated = await service.update({
        folderId: "f-root-1",
        userId: "user-1",
        patch: {
          name: "Scene 1 Remastered",
          color: "#4CAF50",
          description: "High-resolution renders",
        },
      });
      assert.equal(updated.name, "Scene 1 Remastered");
      assert.equal(updated.color, "#4CAF50");
      assert.equal(updated.description, "High-resolution renders");
    });

    it("unified edit: clears color and description when explicitly set to null", async () => {
      // First set them
      await service.update({
        folderId: "f-root-1",
        userId: "user-1",
        patch: { color: "#123456", description: "Temporary description" },
      });
      // Then clear them
      const cleared = await service.update({
        folderId: "f-root-1",
        userId: "user-1",
        patch: { color: null, description: null },
      });
      assert.equal(cleared.color, null);
      assert.equal(cleared.description, null);
      assert.equal(cleared.name, "Scene 1"); // name remains untouched
    });

    it("validation: rejects invalid color type or overly long color", async () => {
      await assert.rejects(
        async () => {
          await service.update({
            folderId: "f-root-1",
            userId: "user-1",
            patch: { color: 12345 },
          });
        },
        (err) => {
          assert.equal(err.errorCode, "FOLDER_COLOR_INVALID");
          assert.equal(err.statusCode, 400);
          return true;
        }
      );

      await assert.rejects(
        async () => {
          await service.update({
            folderId: "f-root-1",
            userId: "user-1",
            patch: { color: "a".repeat(55) },
          });
        },
        (err) => {
          assert.equal(err.errorCode, "FOLDER_COLOR_INVALID");
          assert.equal(err.statusCode, 400);
          return true;
        }
      );
    });

    it("validation: rejects invalid description type or overly long description", async () => {
      await assert.rejects(
        async () => {
          await service.update({
            folderId: "f-root-1",
            userId: "user-1",
            patch: { description: ["invalid"] },
          });
        },
        (err) => {
          assert.equal(err.errorCode, "FOLDER_DESCRIPTION_INVALID");
          assert.equal(err.statusCode, 400);
          return true;
        }
      );

      await assert.rejects(
        async () => {
          await service.update({
            folderId: "f-root-1",
            userId: "user-1",
            patch: { description: "x".repeat(2001) },
          });
        },
        (err) => {
          assert.equal(err.errorCode, "FOLDER_DESCRIPTION_INVALID");
          assert.equal(err.statusCode, 400);
          return true;
        }
      );
    });

    it("assertFolderUsable throws NOT_FOUND when folder belongs to another user or project", async () => {
      await assert.rejects(
        async () => {
          await service.assertFolderUsable("f-root-1", "user-B", "proj-1");
        },
        (err) => {
          assert.equal(err.errorCode, "NOT_FOUND");
          assert.equal(err.statusCode, 404);
          return true;
        }
      );
    });
  });
});
}

// ─── Source: folderRepository.test.js ───
{
describe("FolderRepository Integration & Isolation (Task F-T3)", () => {
  let mockStorage = [];
  let workflowStorage = [];
  let repo;

  // Build a query chain mock simulating Supabase query builder
  function createMockClient() {
    return {
      from(tableName) {
        let filters = [];
        let orderSpecs = [];
        let isSingle = false;
        let isMaybeSingle = false;
        let isCountHead = false;
        let insertData = null;
        let updateData = null;
        let isDelete = false;

        const builder = {
          select(selectStr, options = {}) {
            if (options.head) isCountHead = true;
            return builder;
          },
          eq(col, val) {
            filters.push({ col, op: "eq", val });
            return builder;
          },
          in(col, vals) {
            filters.push({ col, op: "in", val: new Set(vals || []) });
            return builder;
          },
          not(col, op, val) {
            filters.push({ col, op: "not", val });
            return builder;
          },
          order(col, { ascending } = { ascending: true }) {
            orderSpecs.push({ col, ascending });
            return builder;
          },
          insert(data) {
            insertData = data;
            return builder;
          },
          update(data) {
            updateData = data;
            return builder;
          },
          delete() {
            isDelete = true;
            return builder;
          },
          single() {
            isSingle = true;
            return builder.then();
          },
          maybeSingle() {
            isMaybeSingle = true;
            return builder.then();
          },
          async then(resolve, reject) {
            try {
              const targetStore =
                tableName === "folders"
                  ? mockStorage
                  : tableName === "trash"
                    ? []
                    : workflowStorage;

              if (insertData) {
                const inserted = {
                  id: insertData.id || `f-${Date.now()}-${Math.random()}`,
                  created_at: new Date().toISOString(),
                  updated_at: new Date().toISOString(),
                  ...insertData,
                };
                targetStore.push(inserted);
                const res = { data: inserted, error: null };
                return resolve ? resolve(res) : res;
              }

              if (isDelete) {
                const beforeLen = targetStore.length;
                const remaining = targetStore.filter((row) => {
                  return !filters.every((f) => {
                    if (f.op === "eq") return row[f.col] === f.val;
                    return true;
                  });
                });
                const deletedRows = targetStore.filter((row) => {
                  return filters.every((f) => {
                    if (f.op === "eq") return row[f.col] === f.val;
                    return true;
                  });
                });
                targetStore.length = 0;
                targetStore.push(...remaining);
                const res = { data: deletedRows, error: null };
                return resolve ? resolve(res) : res;
              }

              if (updateData) {
                let updatedRow = null;
                for (const row of targetStore) {
                  const match = filters.every((f) => {
                    if (f.op === "eq") return row[f.col] === f.val;
                    return true;
                  });
                  if (match) {
                    Object.assign(row, updateData);
                    updatedRow = row;
                  }
                }
                const res = { data: updatedRow, error: null };
                return resolve ? resolve(res) : res;
              }

              // Query / filter
              let filtered = targetStore.filter((row) => {
                return filters.every((f) => {
                  if (f.op === "eq") return row[f.col] === f.val;
                  if (f.op === "in") return f.val.has(row[f.col]);
                  if (f.op === "not") return row[f.col] !== f.val;
                  return true;
                });
              });

              if (isCountHead) {
                const res = { count: filtered.length, error: null };
                return resolve ? resolve(res) : res;
              }

              // Apply orders
              for (const { col, ascending } of orderSpecs) {
                filtered.sort((a, b) => {
                  const va = a[col] ?? "";
                  const vb = b[col] ?? "";
                  return ascending ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
                });
              }

              let data = filtered;
              if (isSingle) data = filtered[0] || null;
              if (isMaybeSingle) data = filtered[0] || null;

              const res = { data, error: null };
              return resolve ? resolve(res) : res;
            } catch (err) {
              if (reject) return reject(err);
              throw err;
            }
          },
        };
        return builder;
      },
    };
  }

  beforeEach(() => {
    mockStorage = [
      {
        id: "folder-A1",
        project_id: "proj-A",
        user_id: "user-A",
        parent_id: null,
        name: "Folder A1",
        position: 0,
      },
      {
        id: "folder-A2",
        project_id: "proj-A",
        user_id: "user-A",
        parent_id: "folder-A1",
        name: "Folder A2 Child",
        position: 1,
      },
      {
        id: "folder-B1",
        project_id: "proj-B",
        user_id: "user-B",
        parent_id: null,
        name: "Folder B1",
        position: 0,
      },
    ];

    workflowStorage = [
      { id: "wf-1", project_id: "proj-A", folder_id: "folder-A1", user_id: "user-A" },
      { id: "wf-2", project_id: "proj-A", folder_id: "folder-A1", user_id: "user-A" },
      { id: "wf-3", project_id: "proj-A", folder_id: "folder-A2", user_id: "user-A" },
      { id: "wf-4", project_id: "proj-A", folder_id: null, user_id: "user-A" },
    ];

    repo = new FolderRepository(createMockClient());
  });

  describe("Multi-Tenant Isolation", () => {
    it("User B cannot find User A's folder via findOwned", async () => {
      const res = await repo.findOwned("folder-A1", "user-B");
      assert.equal(res, null);
    });

    it("User B cannot find User A's folder via findOwnedInProject", async () => {
      const res = await repo.findOwnedInProject("folder-A1", "proj-A", "user-B");
      assert.equal(res, null);
    });

    it("User B cannot update User A's folder via updateOwned", async () => {
      const res = await repo.updateOwned("folder-A1", "user-B", { name: "Hacked Folder" });
      assert.equal(res, null);
      // Verify storage was not mutated
      const target = mockStorage.find((f) => f.id === "folder-A1");
      assert.equal(target.name, "Folder A1");
    });

    it("User B cannot delete User A's folder via deleteOwned", async () => {
      const res = await repo.deleteOwned("folder-A1", "user-B");
      assert.equal(res, false);
      assert.equal(mockStorage.some((f) => f.id === "folder-A1"), true);
    });

    it("listByProject returns only folders for the specified project and user", async () => {
      const userAFolders = await repo.listByProject("proj-A", "user-A");
      assert.equal(userAFolders.length, 2);
      assert.deepEqual(userAFolders.map((f) => f.id), ["folder-A1", "folder-A2"]);

      const userBFolders = await repo.listByProject("proj-A", "user-B");
      assert.equal(userBFolders.length, 0);
    });
  });

  describe("Legitimate Owner Operations", () => {
    it("create adds a new folder with proper project and user scope", async () => {
      const created = await repo.create({
        projectId: "proj-A",
        userId: "user-A",
        parentId: null,
        name: "New Folder",
        position: 2,
      });

      assert.equal(created.project_id, "proj-A");
      assert.equal(created.user_id, "user-A");
      assert.equal(created.name, "New Folder");
      assert.equal(created.position, 2);
    });

    it("updateOwned successfully updates name and position for legitimate owner", async () => {
      const updated = await repo.updateOwned("folder-A1", "user-A", {
        name: "Renamed Folder",
        position: 10,
      });

      assert.equal(updated.name, "Renamed Folder");
      assert.equal(updated.position, 10);
      assert.equal(updated.project_id, "proj-A"); // Unchanged
    });

    it("updateOwned ignores attempts to modify projectId or userId", async () => {
      const updated = await repo.updateOwned("folder-A1", "user-A", {
        name: "Safe Name",
        projectId: "foreign-proj",
        userId: "foreign-user",
      });

      assert.equal(updated.name, "Safe Name");
      assert.equal(updated.project_id, "proj-A");
      assert.equal(updated.user_id, "user-A");
    });

    it("deleteOwned removes the folder for legitimate owner", async () => {
      const deleted = await repo.deleteOwned("folder-A2", "user-A");
      assert.equal(deleted, true);
      assert.equal(mockStorage.some((f) => f.id === "folder-A2"), false);
    });
  });

  describe("Absence and Blocking of Unscoped Methods", () => {
    it("unscoped findById throws an error preventing unscoped access", async () => {
      await assert.rejects(
        async () => {
          await repo.findById("folder-A1");
        },
        /unscoped repository access is forbidden/i
      );
    });

    it("unscoped deleteById throws an error preventing unscoped access", async () => {
      await assert.rejects(
        async () => {
          await repo.deleteById("folder-A1");
        },
        /unscoped repository access is forbidden/i
      );
    });

    it("unscoped delete throws an error preventing unscoped access", async () => {
      await assert.rejects(
        async () => {
          await repo.delete("folder-A1");
        },
        /unscoped repository access is forbidden/i
      );
    });
  });

  describe("Counting Helpers", () => {
    it("countAssetsByFolder returns grouped folder counts for project workflows", async () => {
      const counts = await repo.countAssetsByFolder("proj-A", "user-A");
      assert.deepEqual(counts, {
        "folder-A1": 2,
        "folder-A2": 1,
      });
    });

    it("countChildren returns count of child folders", async () => {
      const count = await repo.countChildren("folder-A1", "user-A");
      assert.equal(count, 1);
    });

    it("countAssetsIn returns count of assets directly in folder", async () => {
      const count = await repo.countAssetsIn("folder-A1", "user-A");
      assert.equal(count, 2);
    });

    it("countByProject returns total folder count in project", async () => {
      const count = await repo.countByProject("proj-A", "user-A");
      assert.equal(count, 2);
    });
  });
});
}

// ─── Source: folderRoutes.test.js ───
{
process.env.NODE_ENV = "test";

describe("Folder Routes HTTP Acceptance & Security (Task F-T5)", () => {
  let server;
  let baseUrl;
  let origGetUser;
  let origWorkflowService;
  let origTrashInsertMany;

  // In-memory data store for the test suite
  let projects = [];
  let folders = [];
  let workflows = [];
  let trashRows = [];
  let deletedFolderOrder = [];

  before(async () => {
    origWorkflowService = folderService.workflowService;
    origTrashInsertMany = db.trash.insertManyIfAbsent;
    origGetUser = supabase.auth.getUser;
    supabase.auth.getUser = async (token) => {
      if (token === "token-user-A") {
        return { data: { user: { id: "user-A" } }, error: null };
      }
      if (token === "token-user-B") {
        return { data: { user: { id: "user-B" } }, error: null };
      }
      return { data: { user: null }, error: new Error("Invalid token") };
    };

    const app = express();
    app.use(express.json());
    app.use("/api", apiRouter);
    app.use((err, req, res, next) => {
      res.status(err.statusCode || 500).json({
        ok: false,
        message: err.message,
        errorCode: err.errorCode || "INTERNAL_ERROR",
      });
    });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    folderService.setWorkflowService(origWorkflowService);
    db.trash.insertManyIfAbsent = origTrashInsertMany;
    supabase.auth.getUser = origGetUser;
    try {
      await redisConnection?.quit().catch(() => redisConnection?.disconnect());
      await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
      await rateLimitRedisConnection?.quit().catch(() => rateLimitRedisConnection?.disconnect());
    } catch {}
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  beforeEach(() => {
    projects = [
      { id: "proj-A", user_id: "user-A", name: "User A Project" },
      { id: "proj-B", user_id: "user-B", name: "User B Project" },
    ];

    folders = [
      {
        id: "f-root-A1",
        project_id: "proj-A",
        user_id: "user-A",
        parent_id: null,
        name: "Scene 1",
        position: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: "f-sub-A1",
        project_id: "proj-A",
        user_id: "user-A",
        parent_id: "f-root-A1",
        name: "Shots",
        position: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        id: "f-root-B1",
        project_id: "proj-B",
        user_id: "user-B",
        parent_id: null,
        name: "Scene 1",
        position: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    workflows = [
      { id: "wf-1", project_id: "proj-A", folder_id: "f-root-A1", user_id: "user-A" },
    ];
    trashRows = [];
    deletedFolderOrder = [];

    // Mock project ownership checks
    db.projects.findByUser = async (userId, projectId) => {
      const p = projects.find((proj) => proj.id === projectId && proj.user_id === userId);
      return p ? [p] : [];
    };

    db.projects.findById = async (projectId) => {
      return projects.find((proj) => proj.id === projectId) || null;
    };

    // Mock folder repo
    db.folders.listByProject = async (projectId, userId) => {
      return folders
        .filter((f) => f.project_id === projectId && f.user_id === userId)
        .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    };

    db.folders.findOwned = async (folderId, userId) => {
      return folders.find((f) => f.id === folderId && f.user_id === userId) || null;
    };

    db.folders.findOwnedInProject = async (folderId, projectId, userId) => {
      return (
        folders.find(
          (f) => f.id === folderId && f.project_id === projectId && f.user_id === userId
        ) || null
      );
    };

    db.folders.countByProject = async (projectId, userId) => {
      return folders.filter((f) => f.project_id === projectId && f.user_id === userId).length;
    };

    db.folders.create = async ({ projectId, userId, parentId, name, color, description, position }) => {
      const newFolder = {
        id: `f-new-${Date.now()}-${Math.random()}`,
        project_id: projectId,
        user_id: userId,
        parent_id: parentId || null,
        name,
        color: color || null,
        description: description || null,
        position,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      folders.push(newFolder);
      return newFolder;
    };

    db.folders.updateOwned = async (folderId, userId, patch) => {
      const f = folders.find((fol) => fol.id === folderId && fol.user_id === userId);
      if (!f) return null;
      if (patch.name !== undefined) f.name = patch.name;
      if (patch.color !== undefined) f.color = patch.color;
      if (patch.description !== undefined) f.description = patch.description;
      if (patch.parentId !== undefined) f.parent_id = patch.parentId;
      if (patch.position !== undefined) f.position = patch.position;
      f.updated_at = new Date().toISOString();
      return f;
    };

    db.folders.deleteOwned = async (folderId, userId) => {
      const idx = folders.findIndex((fol) => fol.id === folderId && fol.user_id === userId);
      if (idx === -1) return false;
      deletedFolderOrder.push(folderId);
      folders.splice(idx, 1);
      return true;
    };

    db.trash.insertManyIfAbsent = async ({ workflowIds = [], userId, deletedBy = userId } = {}) => {
      const inserted = [];
      for (const workflowId of workflowIds) {
        if (!trashRows.some((t) => t.workflow_id === workflowId)) {
          const row = {
            id: `trash-${workflowId}`,
            workflow_id: workflowId,
            user_id: userId,
            deleted_by: deletedBy ?? userId,
            deleted_at: "2026-11-21T00:00:00.000Z",
          };
          trashRows.push(row);
          inserted.push(row);
        }
      }
      return inserted;
    };

    db.folders.countAssetsByFolder = async (projectId, userId) => {
      const map = {};
      for (const wf of workflows) {
        if (wf.project_id === projectId && wf.folder_id) {
          map[wf.folder_id] = (map[wf.folder_id] || 0) + 1;
        }
      }
      return map;
    };

    db.folders.countChildren = async (folderId, userId) => {
      return folders.filter((f) => f.parent_id === folderId && f.user_id === userId).length;
    };

    db.folders.countAssetsIn = async (folderId, userId) => {
      return workflows.filter((wf) => wf.folder_id === folderId).length;
    };

    folderService.setWorkflowService({
      listOwnedWorkflowIdsInFolders: async ({ folderIds, projectId }) => {
        return workflows
          .filter((wf) => wf.project_id === projectId && folderIds.includes(wf.folder_id))
          .map((wf) => wf.id);
      },
      unlinkWorkflowsFromFolders: async ({ workflowIds, folderIds, projectId }) => {
        const unlinked = [];
        for (const wf of workflows) {
          if (
            wf.project_id === projectId &&
            workflowIds.includes(wf.id) &&
            folderIds.includes(wf.folder_id)
          ) {
            wf.folder_id = null;
            unlinked.push(wf.id);
          }
        }
        return {
          workflow_ids: unlinked,
          count: unlinked.length,
        };
      },
    });
  });

  describe("Authentication & Boundary Hardening", () => {
    it("returns 401 when request is unauthenticated (no token)", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-A/folders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Unauth Folder" }),
      });
      assert.equal(res.status, 401);
    });

    it("ignores internal secret and returns 401 for folder routes even if INTERNAL_AUTH_ENABLED=true", async () => {
      const origEnabled = process.env.INTERNAL_AUTH_ENABLED;
      process.env.INTERNAL_AUTH_ENABLED = "true";
      try {
        const res = await fetch(`${baseUrl}/api/projects/proj-A/folders`, {
          method: "POST",
          headers: {
            "x-internal-secret": process.env.INTERNAL_SECRET,
            "x-user-id": "user-A",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: "Secret Folder" }),
        });
        assert.equal(res.status, 401); // Internal secret not allowlisted on folder routes
      } finally {
        process.env.INTERNAL_AUTH_ENABLED = origEnabled;
      }
    });

    it("returns 404 when User B tries to create a folder in User A's project (cross-tenant)", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-A/folders`, {
        method: "POST",
        headers: {
          Authorization: "Bearer token-user-B",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Cross Folder" }),
      });
      assert.equal(res.status, 404);
    });

    it("returns 404 when User B tries to update User A's folder (cross-tenant)", async () => {
      const res = await fetch(`${baseUrl}/api/folders/f-root-A1`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-B",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Attacker Rename" }),
      });
      assert.equal(res.status, 404);
    });

    it("returns 404 when User B tries to delete User A's folder (cross-tenant) without mutating folders, workflows, or trash", async () => {
      const res = await fetch(`${baseUrl}/api/folders/f-root-A1`, {
        method: "DELETE",
        headers: { Authorization: "Bearer token-user-B" },
      });
      assert.equal(res.status, 404);
      assert.equal(folders.some((f) => f.id === "f-root-A1"), true);
      assert.equal(workflows.find((w) => w.id === "wf-1").folder_id, "f-root-A1");
      assert.equal(trashRows.length, 0);
    });
  });

  describe("Acceptance Scenarios 1 to 6 & 10", () => {
    it("Scenario 1: creates root folder successfully (POST /api/projects/:id/folders)", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-A/folders`, {
        method: "POST",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "New Root Scene" }),
      });

      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.name, "New Root Scene");
      assert.equal(data.parentId, null);
      assert.equal(data.projectId, "proj-A");
    });

    it("Scenario 2: creates sub-folder under existing folder", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-A/folders`, {
        method: "POST",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Angles", parentId: "f-root-A1" }),
      });

      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.name, "Angles");
      assert.equal(data.parentId, "f-root-A1");
    });

    it("creates sub-folder when parentId is provided in request body", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-A/folders`, {
        method: "POST",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Sub Collection A", parentId: "f-root-A1" }),
      });

      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.name, "Sub Collection A");
      assert.equal(data.parentId, "f-root-A1");
    });

    it("Scenario 3: renames folder successfully (PATCH /api/folders/:id)", async () => {
      const res = await fetch(`${baseUrl}/api/folders/f-root-A1`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "Scene 1 - Final Cut" }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.name, "Scene 1 - Final Cut");
    });

    it("Scenario 4: moves folder to root or another parent", async () => {
      const res = await fetch(`${baseUrl}/api/folders/f-sub-A1`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ parentId: null }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.parentId, null);
    });

    it("Scenario 6: deletes folder and nested subfolders deepest-first while moving contained workflows to Trash and unlinking folder_id (204)", async () => {
      folders.push({
        id: "f-leaf-A1",
        project_id: "proj-A",
        user_id: "user-A",
        parent_id: "f-sub-A1",
        name: "Takes",
        position: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      workflows.push(
        { id: "wf-sub", project_id: "proj-A", folder_id: "f-sub-A1", user_id: "user-A" },
        { id: "wf-leaf", project_id: "proj-A", folder_id: "f-leaf-A1", user_id: "user-A" }
      );

      const res = await fetch(`${baseUrl}/api/folders/f-root-A1`, {
        method: "DELETE",
        headers: { Authorization: "Bearer token-user-A" },
      });

      assert.equal(res.status, 204);
      assert.deepEqual(deletedFolderOrder, ["f-leaf-A1", "f-sub-A1", "f-root-A1"]);
      assert.equal(folders.some((f) => f.id === "f-root-A1"), false);
      assert.equal(folders.some((f) => f.id === "f-sub-A1"), false);
      assert.equal(folders.some((f) => f.id === "f-leaf-A1"), false);

      // Workflows preserved (not hard-deleted), unlinked to project root, and moved to Trash
      assert.deepEqual(workflows.map((wf) => wf.id).sort(), ["wf-1", "wf-leaf", "wf-sub"]);
      assert.equal(workflows.every((wf) => wf.folder_id === null), true);
      assert.deepEqual(trashRows.map((t) => t.workflow_id).sort(), ["wf-1", "wf-leaf", "wf-sub"]);
    });

    it("Scenario 6b: preserves already-trashed workflow in deleted folder with original deleted_at intact (204)", async () => {
      const earlierDeletedAt = "2026-10-10T08:00:00.000Z";
      trashRows.push({
        id: "trash-existing",
        workflow_id: "wf-1",
        user_id: "user-A",
        deleted_by: "user-A",
        deleted_at: earlierDeletedAt,
      });

      const res = await fetch(`${baseUrl}/api/folders/f-root-A1`, {
        method: "DELETE",
        headers: { Authorization: "Bearer token-user-A" },
      });

      assert.equal(res.status, 204);
      assert.equal(folders.some((f) => f.id === "f-root-A1"), false);
      assert.equal(workflows.length, 1);
      assert.equal(workflows[0].id, "wf-1");
      assert.equal(workflows[0].folder_id, null);
      assert.equal(trashRows.length, 1);
      assert.equal(trashRows[0].deleted_at, earlierDeletedAt);
    });

    it("Scenario 5: deletes empty folder successfully with zero trash inserts (204 No Content)", async () => {
      // f-sub-A1 has 0 assets and 0 sub-folders
      const res = await fetch(`${baseUrl}/api/folders/f-sub-A1`, {
        method: "DELETE",
        headers: { Authorization: "Bearer token-user-A" },
      });

      assert.equal(res.status, 204);
      assert.equal(folders.some((f) => f.id === "f-sub-A1"), false);
      assert.equal(trashRows.length, 0);
    });

    it("Scenario 6c: aborts folder deletion when trash insertion fails and preserves folders", async () => {
      db.trash.insertManyIfAbsent = async () => {
        throw new Error("Simulated trash write failure");
      };

      const res = await fetch(`${baseUrl}/api/folders/f-root-A1`, {
        method: "DELETE",
        headers: { Authorization: "Bearer token-user-A" },
      });

      assert.equal(res.status, 500);
      assert.equal(folders.some((f) => f.id === "f-root-A1"), true);
      assert.equal(folders.some((f) => f.id === "f-sub-A1"), true);
      assert.equal(workflows.find((wf) => wf.id === "wf-1").folder_id, "f-root-A1");
    });

    it("Scenario 6d: DELETE /api/folders/:folderId returns 409 MEDIA_PROCESSING when folder contains processing media and leaves folder untouched", async () => {
      const origFindStatuses = db.workflowMedia.findMediaStatusesByWorkflowIds;
      db.workflowMedia.findMediaStatusesByWorkflowIds = async () =>
        new Map([["wf-1", [{ id: "m-proc", status: "processing", url: null }]]]);

      try {
        const res = await fetch(`${baseUrl}/api/folders/f-root-A1`, {
          method: "DELETE",
          headers: { Authorization: "Bearer token-user-A" },
        });

        assert.equal(res.status, 409);
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.equal(body.errorCode, "MEDIA_PROCESSING");
        assert.equal(folders.some((f) => f.id === "f-root-A1"), true);
        assert.equal(trashRows.length, 0);
        assert.equal(workflows.find((wf) => wf.id === "wf-1").folder_id, "f-root-A1");
      } finally {
        db.workflowMedia.findMediaStatusesByWorkflowIds = origFindStatuses;
      }
    });

    it("Scenario 6e: DELETE /api/folders/:folderId returns 204, hard-deletes failed-only workflow via owner-aware handler without trashing, and trashes succeeded workflow", async () => {
      const origFindStatuses = db.workflowMedia.findMediaStatusesByWorkflowIds;
      const origPermanentDelete = folderService.permanentDeleteWorkflow;
      assert.equal(typeof origPermanentDelete, "function", "container folderService must wire permanentDeleteWorkflow");

      const hardDeleted = [];
      workflows.push({ id: "wf-failed", project_id: "proj-A", folder_id: "f-sub-A1", user_id: "user-A" });

      db.workflowMedia.findMediaStatusesByWorkflowIds = async () =>
        new Map([
          ["wf-1", [{ id: "m-ok", status: "completed", url: "https://cdn/ok.png" }]],
          ["wf-failed", [{ id: "m-fail", status: "failed", url: null }]],
        ]);
      folderService.setPermanentDeleteWorkflow(async ({ workflowId }) => {
        hardDeleted.push(workflowId);
        const idx = workflows.findIndex((w) => w.id === workflowId);
        if (idx !== -1) workflows.splice(idx, 1);
        return { workflowId, deletedMediaCount: 1 };
      });

      try {
        const res = await fetch(`${baseUrl}/api/folders/f-root-A1`, {
          method: "DELETE",
          headers: { Authorization: "Bearer token-user-A" },
        });

        assert.equal(res.status, 204);
        assert.deepEqual(hardDeleted, ["wf-failed"]);
        assert.deepEqual(trashRows.map((t) => t.workflow_id), ["wf-1"]);
        assert.equal(folders.some((f) => f.id === "f-root-A1"), false);
        assert.equal(folders.some((f) => f.id === "f-sub-A1"), false);
      } finally {
        db.workflowMedia.findMediaStatusesByWorkflowIds = origFindStatuses;
        folderService.setPermanentDeleteWorkflow(origPermanentDelete);
      }
    });

    it("confirms standalone GET /api/projects/:projectId/folders is removed (returns 404)", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-A/folders`, {
        headers: { Authorization: "Bearer token-user-A" },
      });

      assert.equal(res.status, 404);
    });

    it("Scenario 10: rejects invalid folder name with FOLDER_NAME_INVALID", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-A/folders`, {
        method: "POST",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ name: "   " }),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.errorCode, "FOLDER_NAME_INVALID");
    });

    it("Scenario 10: rejects cyclic folder move with FOLDER_CYCLE", async () => {
      const res = await fetch(`${baseUrl}/api/folders/f-root-A1`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ parentId: "f-root-A1" }),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.errorCode, "FOLDER_CYCLE");
    });

    it("rate limiting: returns 429 when folderWrite points are exceeded", async () => {
      setLimiterForTest("folderWrite", {
        consume: async () => {
          const err = new Error("Rate limit exceeded");
          err.msBeforeNext = 15000;
          throw err;
        },
      });

      try {
        const res = await fetch(`${baseUrl}/api/projects/proj-A/folders`, {
          method: "POST",
          headers: {
            Authorization: "Bearer token-user-A",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ name: "Spam Folder" }),
        });

        assert.equal(res.status, 429);
      } finally {
        resetLimitersForTest();
      }
    });

    it("Scenario 11: creates folder/collection with color and description via POST /api/projects/:id/folders", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-A/folders`, {
        method: "POST",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Character Styles",
          color: "#E91E63",
          description: "All prompt styles and references",
        }),
      });

      assert.equal(res.status, 201);
      const data = await res.json();
      assert.equal(data.name, "Character Styles");
      assert.equal(data.color, "#E91E63");
      assert.equal(data.description, "All prompt styles and references");
    });

    it("Scenario 12: unified edit updates ONLY color when only color is sent (other fields untouched)", async () => {
      const res = await fetch(`${baseUrl}/api/folders/f-root-A1`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ color: "#2196F3" }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.id, "f-root-A1");
      assert.equal(data.color, "#2196F3");
      assert.equal(data.name, "Scene 1"); // Unchanged
    });

    it("Scenario 13: unified edit updates ONLY description when only description is sent", async () => {
      // Set initial color first
      await fetch(`${baseUrl}/api/folders/f-root-A1`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ color: "#2196F3" }),
      });

      const res = await fetch(`${baseUrl}/api/folders/f-root-A1`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ description: "Updated collection description" }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.description, "Updated collection description");
      assert.equal(data.color, "#2196F3"); // Previously set color preserved
      assert.equal(data.name, "Scene 1"); // Unchanged
    });

    it("Scenario 14: unified edit updates name, color, and description in one call", async () => {
      const res = await fetch(`${baseUrl}/api/folders/f-root-A1`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Scene 1 - Master",
          color: "#00BCD4",
          description: "Master cut collection",
        }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.name, "Scene 1 - Master");
      assert.equal(data.color, "#00BCD4");
      assert.equal(data.description, "Master cut collection");
    });
  });
});
}

// ─── Source: assetFolderMove.test.js ───
{
process.env.NODE_ENV = "test";

describe("Asset Folder Move Route & Mass-Assignment Defense (Task F-T6)", () => {
  let server;
  let baseUrl;
  let origGetUser;

  // In-memory mock store
  let projects = [];
  let folders = [];
  let workflows = [];

  before(async () => {
    origGetUser = supabase.auth.getUser;
    supabase.auth.getUser = async (token) => {
      if (token === "token-user-A") {
        return { data: { user: { id: "user-A" } }, error: null };
      }
      if (token === "token-user-B") {
        return { data: { user: { id: "user-B" } }, error: null };
      }
      return { data: { user: null }, error: new Error("Invalid token") };
    };

    const app = express();
    app.use(express.json());
    app.use("/api", apiRouter);
    app.use((err, req, res, next) => {
      res.status(err.statusCode || 500).json({
        ok: false,
        message: err.message,
        errorCode: err.errorCode || "INTERNAL_ERROR",
      });
    });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    supabase.auth.getUser = origGetUser;
    try {
      await redisConnection?.quit().catch(() => redisConnection?.disconnect());
      await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
      await rateLimitRedisConnection?.quit().catch(() => rateLimitRedisConnection?.disconnect());
    } catch {}
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  beforeEach(() => {
    projects = [
      { id: "proj-A1", user_id: "user-A", name: "User A Project 1" },
      { id: "proj-A2", user_id: "user-A", name: "User A Project 2" },
      { id: "proj-B1", user_id: "user-B", name: "User B Project 1" },
    ];

    folders = [
      {
        id: "00000000-0000-4000-8000-0000000000a1",
        project_id: "proj-A1",
        user_id: "user-A",
        parent_id: null,
        name: "Scene 1",
        position: 0,
      },
      {
        id: "00000000-0000-4000-8000-0000000000a2",
        project_id: "proj-A1",
        user_id: "user-A",
        parent_id: null,
        name: "Scene 2",
        position: 1,
      },
      {
        id: "00000000-0000-4000-8000-0000000000a3",
        project_id: "proj-A2",
        user_id: "user-A",
        parent_id: null,
        name: "Project 2 Folder",
        position: 0,
      },
      {
        id: "00000000-0000-4000-8000-0000000000b1",
        project_id: "proj-B1",
        user_id: "user-B",
        parent_id: null,
        name: "Bob Folder",
        position: 0,
      },
    ];

    workflows = [
      {
        id: "wf-A-1",
        project_id: "proj-A1",
        user_id: "user-A",
        folder_id: "00000000-0000-4000-8000-0000000000a1",
        display_name: "Workflow A1",
        create_time: new Date().toISOString(),
      },
      {
        id: "wf-B-1",
        project_id: "proj-B1",
        user_id: "user-B",
        folder_id: "00000000-0000-4000-8000-0000000000b1",
        display_name: "Workflow B1",
        create_time: new Date().toISOString(),
      },
    ];

    // Mock db.projects
    db.projects.findByUser = async (userId, projectId) => {
      const p = projects.find((proj) => proj.id === projectId && proj.user_id === userId);
      return p ? [p] : [];
    };
    db.projects.findById = async (projectId) => {
      return projects.find((proj) => proj.id === projectId) || null;
    };

    // Mock db.folders
    db.folders.findOwned = async (folderId, userId) => {
      return folders.find((f) => f.id === folderId && f.user_id === userId) || null;
    };
    db.folders.findOwnedInProject = async (folderId, projectId, userId) => {
      return (
        folders.find(
          (f) => f.id === folderId && f.project_id === projectId && f.user_id === userId
        ) || null
      );
    };

    // Mock db.workflows
    db.workflows.findById = async (id) => {
      return workflows.find((w) => w.id === id) || null;
    };
    db.workflows.getWorkflow = async (id) => {
      return workflows.find((w) => w.id === id) || null;
    };
    db.workflows.updateFolderId = async (workflowId, folderId, userId, projectId) => {
      const wf = workflows.find(
        (w) =>
          w.id === workflowId &&
          (!userId || w.user_id === userId) &&
          (!projectId || w.project_id === projectId)
      );
      if (!wf) return null;
      wf.folder_id = folderId;
      return wf;
    };
    db.workflows.updateFields = async (workflowId, fields) => {
      const wf = workflows.find((w) => w.id === workflowId);
      if (!wf) return null;
      Object.assign(wf, fields);
      return wf;
    };
  });

  describe("PATCH /api/assets/:assetId/folder - Dedicated Move Route", () => {
    it("Scenario 8: moves asset from folder A to folder B in same project", async () => {
      const res = await fetch(`${baseUrl}/api/assets/wf-A-1/folder`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ folderId: "00000000-0000-4000-8000-0000000000a2" }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.folderId, "00000000-0000-4000-8000-0000000000a2");
      assert.equal(workflows.find((w) => w.id === "wf-A-1").folder_id, "00000000-0000-4000-8000-0000000000a2");
    });

    it("Scenario 8: moves asset to null (returns to project root)", async () => {
      const res = await fetch(`${baseUrl}/api/assets/wf-A-1/folder`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ folderId: null }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.folderId, null);
      assert.equal(workflows.find((w) => w.id === "wf-A-1").folder_id, null);
    });

    it("Scenario 8: moves asset with folderId='none' (returns to project root)", async () => {
      const res = await fetch(`${baseUrl}/api/assets/wf-A-1/folder`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ folderId: "none" }),
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.folderId, null);
    });

    it("refuses moving asset to a foreign folder (User B's folder) -> 404", async () => {
      const res = await fetch(`${baseUrl}/api/assets/wf-A-1/folder`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ folderId: "00000000-0000-4000-8000-0000000000b1" }),
      });

      assert.equal(res.status, 404);
      // Asset folder must NOT change
      assert.equal(workflows.find((w) => w.id === "wf-A-1").folder_id, "00000000-0000-4000-8000-0000000000a1");
    });

    it("refuses moving asset to a folder of another project of the same user -> 404", async () => {
      const res = await fetch(`${baseUrl}/api/assets/wf-A-1/folder`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ folderId: "00000000-0000-4000-8000-0000000000a3" }),
      });

      assert.equal(res.status, 404);
      assert.equal(workflows.find((w) => w.id === "wf-A-1").folder_id, "00000000-0000-4000-8000-0000000000a1");
    });

    it("refuses moving another user's asset to root (cross-tenant) -> 404", async () => {
      const res = await fetch(`${baseUrl}/api/assets/wf-A-1/folder`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-B",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ folderId: null }),
      });

      assert.equal(res.status, 404);
    });

    it("refuses moving another user's asset into own folder (cross-tenant theft) -> 404", async () => {
      const res = await fetch(`${baseUrl}/api/assets/wf-A-1/folder`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-B",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ folderId: "00000000-0000-4000-8000-0000000000b1" }),
      });

      assert.equal(res.status, 404);
    });

    it("returns 401 when unauthenticated", async () => {
      const res = await fetch(`${baseUrl}/api/assets/wf-A-1/folder`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folderId: null }),
      });

      assert.equal(res.status, 401);
    });

    it("ignores internal secret and returns 401 even if INTERNAL_AUTH_ENABLED=true", async () => {
      const origEnabled = process.env.INTERNAL_AUTH_ENABLED;
      process.env.INTERNAL_AUTH_ENABLED = "true";
      try {
        const res = await fetch(`${baseUrl}/api/assets/wf-A-1/folder`, {
          method: "PATCH",
          headers: {
            "x-internal-secret": process.env.INTERNAL_SECRET,
            "x-user-id": "user-A",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ folderId: null }),
        });

        assert.equal(res.status, 401);
      } finally {
        process.env.INTERNAL_AUTH_ENABLED = origEnabled;
      }
    });

    it("returns 404 if folder is deleted concurrently (FK violation 23503 race)", async () => {
      const origUpdate = db.workflows.updateFolderId;
      db.workflows.updateFolderId = async () => {
        const err = new Error("insert or update on table 'workflow' violates foreign key constraint");
        err.code = "23503";
        throw err;
      };

      try {
        const res = await fetch(`${baseUrl}/api/assets/wf-A-1/folder`, {
          method: "PATCH",
          headers: {
            Authorization: "Bearer token-user-A",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ folderId: "00000000-0000-4000-8000-0000000000a2" }),
        });

        assert.equal(res.status, 404);
        const data = await res.json();
        assert.equal(data.errorCode, "NOT_FOUND");
      } finally {
        db.workflows.updateFolderId = origUpdate;
      }
    });
  });

  describe("Mass-Assignment Defense on Generic Workflow Update Routes", () => {
    it("generic PATCH /api/workflows/:id rejects folderId with 400 even if display_name is present", async () => {
      const res = await fetch(`${baseUrl}/api/workflows/wf-A-1`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ display_name: "Valid Rename", folderId: "folder-A-2" }),
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.ok, false);
    });

    it("generic PATCH /api/workflows/:id rejects folder_id with 400 even if display_name is present", async () => {
      const res = await fetch(`${baseUrl}/api/workflows/wf-A-1`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ display_name: "Valid Rename", folder_id: "folder-A-2" }),
      });

      assert.equal(res.status, 400);
    });

    it("generic PATCH /api/workflows/:id rejects projectId with 400 even if display_name is present", async () => {
      const res = await fetch(`${baseUrl}/api/workflows/wf-A-1`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ display_name: "Valid Rename", projectId: "proj-A2" }),
      });

      assert.equal(res.status, 400);
    });

    it("generic PATCH /api/workflows/:id rejects userId with 400 even if display_name is present", async () => {
      const res = await fetch(`${baseUrl}/api/workflows/wf-A-1`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ display_name: "Valid Rename", userId: "user-B" }),
      });

      assert.equal(res.status, 400);
    });

    it("generic PATCH /api/workflows/workflows/:id rejects folderId/projectId/userId with 400", async () => {
      const res = await fetch(`${baseUrl}/api/workflows/workflows/wf-A-1`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ display_name: "Valid Rename", folderId: "folder-A-2" }),
      });

      assert.equal(res.status, 400);
    });
  });
});
}
