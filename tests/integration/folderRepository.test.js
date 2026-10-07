import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FolderRepository } from "../../src/db/FolderRepository.js";

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
              const targetStore = tableName === "folders" ? mockStorage : workflowStorage;

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
