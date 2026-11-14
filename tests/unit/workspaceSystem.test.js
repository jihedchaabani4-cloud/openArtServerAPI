/**
 * Workspace System (System 8) — Unit & Gateway Contract Tests
 *
 * Verifies System 8 Workspace (#workspace/api, #workspace/tools) boundaries,
 * typed errors, DTO contracts, and project/folder/trash operations.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    assertProjectAccess,
    moveItemToTrash,
    ProjectService,
    ProjectReadService,
    FolderService,
    TrashService,
    folderTree,
    indexById,
    indexChildren,
    getDepth,
    wouldCreateCycle,
    ProjectRepository,
    FolderRepository,
    TrashRepository,
    WorkspaceError,
    WorkspaceValidationError,
    WorkspaceNotFoundError,
    WorkspaceConflictError,
    WorkspaceUnauthorizedError,
    FolderError,
} from "#workspace/tools";

import {
    projectsRouter,
    foldersRouter,
    trashRouter,
    workspaceRouter,
} from "#workspace/api";

describe("System 8: Workspace — Gateways & Public Tools Contract", () => {
    it("should export all expected public tools and facade members", () => {
        assert.equal(typeof assertProjectAccess, "function");
        assert.equal(typeof moveItemToTrash, "function");
        assert.equal(typeof ProjectService, "function");
        assert.equal(typeof ProjectReadService, "function");
        assert.equal(typeof FolderService, "function");
        assert.equal(typeof TrashService, "function");
        assert.equal(typeof ProjectRepository, "function");
        assert.equal(typeof FolderRepository, "function");
        assert.equal(typeof TrashRepository, "function");
        assert.equal(typeof folderTree, "object");
        assert.equal(typeof indexById, "function");
        assert.equal(typeof indexChildren, "function");
        assert.equal(typeof getDepth, "function");
        assert.equal(typeof wouldCreateCycle, "function");
    });

    it("should export valid Express routers from #workspace/api", () => {
        assert.equal(typeof projectsRouter, "function");
        assert.equal(typeof foldersRouter, "function");
        assert.equal(typeof trashRouter, "function");
        assert.equal(typeof workspaceRouter, "function");

        // Verify stack exists on express routers
        assert.ok(Array.isArray(projectsRouter.stack));
        assert.ok(Array.isArray(foldersRouter.stack));
        assert.ok(Array.isArray(trashRouter.stack));
        assert.ok(Array.isArray(workspaceRouter.stack));
    });

    it("should enforce Workspace typed error hierarchy", () => {
        const baseErr = new WorkspaceError("generic", 500);
        assert.equal(baseErr.statusCode, 500);
        assert.equal(baseErr.errorCode, "WORKSPACE_ERROR");

        const valErr = new WorkspaceValidationError("invalid input");
        assert.equal(valErr.statusCode, 400);
        assert.equal(valErr.errorCode, "WORKSPACE_VALIDATION_ERROR");

        const notFoundErr = new WorkspaceNotFoundError("project missing");
        assert.equal(notFoundErr.statusCode, 404);
        assert.equal(notFoundErr.errorCode, "WORKSPACE_NOT_FOUND");

        const conflictErr = new WorkspaceConflictError("conflict detected");
        assert.equal(conflictErr.statusCode, 409);
        assert.equal(conflictErr.errorCode, "WORKSPACE_CONFLICT");

        const authErr = new WorkspaceUnauthorizedError("unauthorized");
        assert.equal(authErr.statusCode, 403);
        assert.equal(authErr.errorCode, "WORKSPACE_UNAUTHORIZED");

        const folderErr = new FolderError("folder validation failed");
        assert.equal(folderErr.statusCode, 400);
        assert.equal(folderErr.errorCode, "FOLDER_ERROR");
    });
});

describe("System 8: Workspace — assertProjectAccess", () => {
    it("should throw WorkspaceValidationError when userId is missing", async () => {
        await assert.rejects(
            () => assertProjectAccess({ projectId: "proj-1" }),
            (err) => {
                assert.ok(err instanceof WorkspaceValidationError);
                assert.equal(err.statusCode, 400);
                assert.match(err.message, /User ID is required/);
                return true;
            }
        );
    });

    it("should throw WorkspaceValidationError when projectId is missing", async () => {
        await assert.rejects(
            () => assertProjectAccess({ userId: "user-1" }),
            (err) => {
                assert.ok(err instanceof WorkspaceValidationError);
                assert.equal(err.statusCode, 400);
                assert.match(err.message, /Project ID is required/);
                return true;
            }
        );
    });

    it("should return ok: true and DTO when project is owned", async () => {
        // Mock findOwnedProject on ProjectRepository
        const originalFind = ProjectRepository.prototype.findOwnedProject;
        try {
            ProjectRepository.prototype.findOwnedProject = async (id, userId) => {
                if (id === "proj-123" && userId === "user-456") {
                    return { id: "proj-123", user_id: "user-456", project_name: "My Studio Project" };
                }
                return null;
            };

            const result = await assertProjectAccess({ userId: "user-456", projectId: "proj-123" });
            assert.equal(result.ok, true);
            assert.deepEqual(result.project, {
                id: "proj-123",
                userId: "user-456",
                name: "My Studio Project",
            });
        } finally {
            ProjectRepository.prototype.findOwnedProject = originalFind;
        }
    });

    it("should throw WorkspaceNotFoundError when project is not found or foreign", async () => {
        const originalFind = ProjectRepository.prototype.findOwnedProject;
        try {
            ProjectRepository.prototype.findOwnedProject = async () => null;

            await assert.rejects(
                () => assertProjectAccess({ userId: "user-456", projectId: "foreign-proj" }),
                (err) => {
                    assert.ok(err instanceof WorkspaceNotFoundError);
                    assert.equal(err.statusCode, 404);
                    assert.match(err.message, /foreign-proj/);
                    return true;
                }
            );
        } finally {
            ProjectRepository.prototype.findOwnedProject = originalFind;
        }
    });
});

describe("System 8: Workspace — moveItemToTrash", () => {
    it("should throw WorkspaceValidationError when userId is missing", async () => {
        await assert.rejects(
            () => moveItemToTrash({ itemId: "wf-1" }),
            (err) => {
                assert.ok(err instanceof WorkspaceValidationError);
                return true;
            }
        );
    });

    it("should throw WorkspaceValidationError when itemId is missing", async () => {
        await assert.rejects(
            () => moveItemToTrash({ userId: "user-1" }),
            (err) => {
                assert.ok(err instanceof WorkspaceValidationError);
                return true;
            }
        );
    });
});

describe("System 8: Workspace — folderTree algorithms", () => {
    it("should index folders correctly and compute depth", () => {
        const folders = [
            { id: "root-1", parentId: null, name: "Root" },
            { id: "child-1", parentId: "root-1", name: "Child 1" },
            { id: "grandchild-1", parentId: "child-1", name: "Grandchild" },
        ];

        const byId = indexById(folders);
        assert.equal(byId.size, 3);
        assert.equal(byId.get("child-1").name, "Child 1");

        const children = indexChildren(folders);
        assert.equal(children.get(null).length, 1);
        assert.equal(children.get("root-1").length, 1);

        assert.equal(getDepth(byId, "root-1"), 1);
        assert.equal(getDepth(byId, "child-1"), 2);
        assert.equal(getDepth(byId, "grandchild-1"), 3);
        assert.equal(getDepth(byId, "non-existent"), 0);
    });

    it("should detect cycle attempts", () => {
        const folders = [
            { id: "root-1", parentId: null },
            { id: "child-1", parentId: "root-1" },
            { id: "grandchild-1", parentId: "child-1" },
        ];
        const byId = indexById(folders);

        // Moving root-1 under grandchild-1 would create a cycle
        assert.equal(wouldCreateCycle(byId, "root-1", "grandchild-1"), true);
        // Moving child-1 to root-1 does not create a cycle
        assert.equal(wouldCreateCycle(byId, "child-1", "root-1"), false);
        // Moving to same folder is a cycle
        assert.equal(wouldCreateCycle(byId, "child-1", "child-1"), true);
    });
});
