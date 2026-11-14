/**
 * Boundary tests: mounted generation-mutation handlers must not leak
 * internal 5xx details, and must keep the fail-closed ownership contract.
 *
 * Covers the handlers actually mounted in routes/workflows.js:
 *   - DELETE /api/workflows/items/:id   -> generationsMutation.deleteItem
 *   - PATCH /api/workflows/items/:id/like -> generationsMutation.toggleLike
 * (deleteGeneration / updateGeneration are unmounted exports and are not
 * touched here.)
 *
 * Harness follows the established container-stub pattern (see
 * tests/unit/generationsMutationController.test.js): container-owned
 * object properties are swapped per test and restored in afterEach, so
 * no database, network, or Supabase access is needed.
 *
 * State-invariant contract classes asserted:
 *   1. unexpected internal failures -> 500 + generic "Internal server error"
 *      + errorCode INTERNAL_ERROR (no exception internals in the body)
 *   2. foreign / missing resource id -> 404 (never 403) with errorCode
 *      NOT_FOUND (cross-tenant contract)
 *   3. missing authentication -> 401 with the AppError public message
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { deleteItem, toggleItemLike as toggleLike } from "#generation/api";
import { db, workflowService } from "../../src/container.js";

const INTERNAL_ERROR = Object.assign(
    new Error("connect ECONNREFUSED 10.0.0.4:5432 credential=sk-internal-77"),
    {}
);

let originalDeleteMedia;
let originalMediaFindById;
let originalProjectsFindByUser;
let hadCollectionItems;

function fakeRes() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };
}

function fakeReq(id, userId) {
    return {
        params: { id },
        user: userId ? { id: userId } : undefined,
    };
}

beforeEach(() => {
    originalDeleteMedia = workflowService?.deleteMedia;
    originalMediaFindById = db.media?.findById;
    originalProjectsFindByUser = db.projects?.findByUser;
    hadCollectionItems = Object.prototype.hasOwnProperty.call(db, "collection_items");
});

afterEach(() => {
    if (workflowService) {
        workflowService.deleteMedia = originalDeleteMedia;
    }
    if (db.media) {
        if (originalMediaFindById === undefined) {
            delete db.media.findById;
        } else {
            db.media.findById = originalMediaFindById;
        }
    }
    if (db.projects) {
        if (originalProjectsFindByUser === undefined) {
            delete db.projects.findByUser;
        } else {
            db.projects.findByUser = originalProjectsFindByUser;
        }
    }
    if (!hadCollectionItems && db.collection_items) {
        delete db.collection_items;
    }
});

describe("generationsMutation mounted-handler error masking boundary", () => {
    it("deleteItem masks unexpected internal failures behind the safe public contract", async () => {
        db.media.findById = async (id) => ({ id, user_id: "user-1" });
        db.collection_items = {
            findById: async (id) => ({ id, user_id: "user-1" }),
            delete: async () => { throw INTERNAL_ERROR; },
        };
        workflowService.deleteMedia = async () => { throw INTERNAL_ERROR; };

        const res = fakeRes();
        await deleteItem(fakeReq("media-1", "user-1"), res);

        assert.equal(res.statusCode, 500);
        assert.equal(res.body.ok, false);
        assert.equal(res.body.message, "Internal server error");
        assert.equal(res.body.errorCode, "INTERNAL_ERROR");

        const serialized = JSON.stringify(res.body);
        assert.ok(!serialized.includes("ECONNREFUSED"), "must not leak connection details");
        assert.ok(!serialized.includes("sk-internal-77"), "must not leak credential-looking fragments");
    });

    it("deleteItem preserves the fail-closed 404 contract for foreign resource ids", async () => {
        db.collection_items = { findById: async () => null };

        const res = fakeRes();
        await deleteItem(fakeReq("media-1", "user-1"), res);

        assert.equal(res.statusCode, 404);
        assert.equal(res.body.ok, false);
        assert.equal(res.body.errorCode, "NOT_FOUND");
        assert.match(res.body.message, /not found/i);
    });

    it("toggleLike preserves the fail-closed 404 contract for foreign resource ids", async () => {
        db.collection_items = { findById: async () => null };

        const res = fakeRes();
        await toggleLike(fakeReq("media-1", "user-1"), res);

        assert.equal(res.statusCode, 404);
        assert.equal(res.body.ok, false);
        assert.equal(res.body.errorCode, "NOT_FOUND");
        assert.match(res.body.message, /not found/i);
    });

    it("deleteItem preserves the public 401 contract when authentication is missing", async () => {
        db.collection_items = { findById: async () => null };

        const res = fakeRes();
        await deleteItem(fakeReq("media-1", undefined), res);

        assert.equal(res.statusCode, 401);
        assert.equal(res.body.ok, false);
        assert.equal(res.body.message, "Authentication required");
        assert.equal(res.body.errorCode, "APP_ERROR");
    });
});
