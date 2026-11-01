import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { deleteItem, toggleLike } from "../../controllers/generationsMutationController.js";
import { workflowService, db } from "../../src/container.js";

describe("generationsMutationController contracts", () => {
    let originalDeleteMedia;
    let originalFindMediaById;
    let originalFindByUser;

    beforeEach(() => {
        originalDeleteMedia = workflowService?.deleteMedia;
        originalFindMediaById = db.media?.findById;
        originalFindByUser = db.projects?.findByUser;

        if (db.media) {
            db.media.findById = async (id) => ({ id, project_id: "proj-1" });
        }
        if (db.projects) {
            db.projects.findByUser = async (userId, projId) => [{ id: "proj-1", user_id: userId }];
        }
    });

    afterEach(() => {
        if (workflowService) {
            workflowService.deleteMedia = originalDeleteMedia;
        }
        if (db.media) {
            db.media.findById = originalFindMediaById;
        }
        if (db.projects) {
            db.projects.findByUser = originalFindByUser;
        }
    });

    it("deleteItem delegates to workflowService.deleteMedia and does not query collection_items", async () => {
        let calledWith = null;
        workflowService.deleteMedia = async (args) => {
            calledWith = args;
            return { deleted: true, mediaId: args.mediaId };
        };

        const req = {
            params: { id: "media-uuid-123" },
            user: { id: "user-1" },
        };
        let responseJson = null;
        const res = {
            status: (s) => res,
            json: (payload) => {
                responseJson = payload;
                return res;
            },
        };

        await deleteItem(req, res);

        assert.ok(calledWith, "workflowService.deleteMedia should have been called");
        assert.equal(calledWith.mediaId, "media-uuid-123");
        assert.equal(calledWith.userId, "user-1");
        assert.equal(responseJson?.ok, true);
    });

    it("deleteItem maps itemId to mediaId and deletes only the target media relationship, preserving unrelated links", async () => {
        const remainingWorkflowLinks = [
            { workflow_id: "wf-1", media_id: "media-sibling-1", role: "output" },
            { workflow_id: "wf-1", media_id: "target-media-to-delete", role: "output" },
            { workflow_id: "wf-1", media_id: "media-sibling-2", role: "detail" },
            { workflow_id: "wf-2", media_id: "media-other-wf", role: "sheet" },
        ];

        let deleteMediaCalls = [];
        workflowService.deleteMedia = async ({ mediaId, userId }) => {
            deleteMediaCalls.push({ mediaId, userId });
            const idx = remainingWorkflowLinks.findIndex((l) => l.media_id === mediaId);
            if (idx >= 0) {
                remainingWorkflowLinks.splice(idx, 1);
            }
            return { deleted: true, mediaId, workflow_deleted: false };
        };

        const req = {
            params: { id: "target-media-to-delete" },
            user: { id: "user-owner" },
        };
        let responseJson = null;
        const res = {
            status: () => res,
            json: (payload) => {
                responseJson = payload;
                return res;
            },
        };

        await deleteItem(req, res);

        assert.equal(deleteMediaCalls.length, 1);
        assert.equal(deleteMediaCalls[0].mediaId, "target-media-to-delete", "itemId must map precisely to mediaId");
        assert.equal(deleteMediaCalls[0].userId, "user-owner");
        assert.equal(responseJson?.ok, true);
        assert.equal(responseJson?.deleted, true);
        assert.equal(responseJson?.workflow_deleted, false);

        // Verify that unrelated links in the same workflow and other workflows were preserved
        const remainingMediaIds = remainingWorkflowLinks.map((l) => l.media_id);
        assert.deepEqual(remainingMediaIds, [
            "media-sibling-1",
            "media-sibling-2",
            "media-other-wf",
        ], "Unrelated workflow/media links must remain untouched");
    });

    it("deleteItem propagates 404 when user does not own media", async () => {
        workflowService.deleteMedia = async () => {
            const err = new Error("Media not found");
            err.statusCode = 404;
            throw err;
        };

        const req = {
            params: { id: "foreign-media-uuid" },
            user: { id: "user-attacker" },
        };
        let responseStatus = null;
        let responseJson = null;
        const res = {
            status: (s) => {
                responseStatus = s;
                return res;
            },
            json: (payload) => {
                responseJson = payload;
                return res;
            },
        };

        await deleteItem(req, res);

        assert.equal(responseStatus, 404, "Must return 404 on cross-tenant delete attempt");
        assert.equal(responseJson?.ok, false);
    });

    it("toggleLike returns explicit 501 NOT_SUPPORTED error instead of hardcoded success", async () => {
        const req = {
            params: { id: "media-uuid-123" },
            user: { id: "user-1" },
        };
        let responseStatus = null;
        let responseJson = null;
        const res = {
            status: (s) => {
                responseStatus = s;
                return res;
            },
            json: (payload) => {
                responseJson = payload;
                return res;
            },
        };

        await toggleLike(req, res);

        assert.equal(responseStatus, 501, "Expected 501 Not Implemented");
        assert.equal(responseJson?.ok, false);
        assert.equal(responseJson?.errorCode, "NOT_SUPPORTED");
        assert.match(responseJson?.message, /Item-level like is not supported/i);
    });
});
