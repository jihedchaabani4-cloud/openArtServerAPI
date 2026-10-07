import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FolderService, FolderError } from "../../src/domain/folder/FolderService.js";

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
      create: async ({ projectId, userId, parentId, name, position }) => {
        const newFolder = {
          id: `f-${Date.now()}-${Math.random()}`,
          project_id: projectId,
          user_id: userId,
          parent_id: parentId || null,
          name,
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

    it("throws FOLDER_NOT_EMPTY when deleting folder with sub-folders or assets", async () => {
      // f-root-1 has child f-child-1 and assets
      await assert.rejects(
        async () => {
          await service.remove({ folderId: "f-root-1", userId: "user-1" });
        },
        (err) => {
          assert.equal(err.errorCode, "FOLDER_NOT_EMPTY");
          assert.equal(err.statusCode, 409);
          return true;
        }
      );
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
