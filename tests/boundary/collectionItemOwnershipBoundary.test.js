import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import workflowsRouter from "../../routes/workflows.js";
import { db } from "../../src/container.js";
import { rateLimitRedisConnection, redisConnection, workerRedisConnection } from "../../src/queue/redis.js";
import { supabase } from "../../lib/supabase.js";

describe("RC1.1-R2 — Collection Items Ownership & Generic Delete Helpers Boundary Tests", () => {
  let server;
  let baseUrl;
  let activeUserId = "user-alice";
  let origGetUser;

  // Spies and original mocks
  let originalCollectionItems;
  let deletedItemIds = [];

  after(async () => {
    supabase.auth.getUser = origGetUser;
    await Promise.allSettled([
      rateLimitRedisConnection?.quit().catch(() => rateLimitRedisConnection?.disconnect()),
      redisConnection?.quit().catch(() => redisConnection?.disconnect()),
      workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect()),
    ]);
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  before(async () => {
    origGetUser = supabase.auth.getUser;
    supabase.auth.getUser = async (token) => {
      if (token === "token-user-alice") {
        return { data: { user: { id: "user-alice" } }, error: null };
      }
      if (token === "token-user-bob") {
        return { data: { user: { id: "user-bob" } }, error: null };
      }
      return { data: { user: null }, error: new Error("Invalid token") };
    };

    const app = express();
    app.use(express.json());
    app.use("/api/workflows", workflowsRouter);
    app.use((err, req, res, next) => {
      res.status(err.statusCode || 500).json({
        ok: false,
        message: err.message,
      });
    });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  beforeEach(() => {
    deletedItemIds = [];
    originalCollectionItems = db.collection_items;

    // Mock collection_items repository
    db.collection_items = {
      findById: async (id) => {
        if (id === "item-alice-1") {
          return { id: "item-alice-1", user_id: "user-alice" };
        }
        if (id === "item-bob-1") {
          return { id: "item-bob-1", user_id: "user-bob" };
        }
        return null;
      },
      delete: async (id) => {
        deletedItemIds.push(id);
        return true;
      },
    };
  });

  afterEach(() => {
    db.collection_items = originalCollectionItems;
  });

  // ── TEST 1: Foreign user deleting collection item returns 404 and prevents deletion ──
  it("TEST 1: Foreign user calling DELETE /api/workflows/items/:id gets 404 and item is NOT deleted", async () => {
    activeUserId = "user-alice"; // Alice attempts to delete Bob's item

    const res = await fetch(`${baseUrl}/api/workflows/items/item-bob-1`, {
      method: "DELETE",
      headers: {
        "Authorization": `Bearer token-${activeUserId}`,
      },
    });

    const body = await res.json();
    assert.equal(res.status, 404, `Expected 404, got ${res.status}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, false);
    assert.match(body.message, /not found/i);
    assert.equal(deletedItemIds.length, 0, "No deletion should have occurred for foreign item");
  });

  // ── TEST 2: Owner deleting collection item succeeds ──
  it("TEST 2: Owner calling DELETE /api/workflows/items/:id succeeds with 200", async () => {
    activeUserId = "user-alice"; // Alice deletes her own item

    const res = await fetch(`${baseUrl}/api/workflows/items/item-alice-1`, {
      method: "DELETE",
      headers: {
        "Authorization": `Bearer token-${activeUserId}`,
      },
    });

    const body = await res.json();
    assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, true);
    assert.deepEqual(deletedItemIds, ["item-alice-1"], "Expected item-alice-1 to be deleted");
  });

  // ── TEST 3: Foreign user toggling like on collection item returns 404 ──
  it("TEST 3: Foreign user calling PATCH /api/workflows/items/:id/like gets 404", async () => {
    activeUserId = "user-alice"; // Alice attempts to toggle like on Bob's item

    const res = await fetch(`${baseUrl}/api/workflows/items/item-bob-1/like`, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer token-${activeUserId}`,
      },
    });

    const body = await res.json();
    assert.equal(res.status, 404, `Expected 404, got ${res.status}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, false);
    assert.match(body.message, /not found/i);
  });

  // ── TEST 4: Owner toggling like on collection item succeeds ──
  it("TEST 4: Owner calling PATCH /api/workflows/items/:id/like succeeds with 200", async () => {
    activeUserId = "user-alice"; // Alice toggles like on her own item

    const res = await fetch(`${baseUrl}/api/workflows/items/item-alice-1/like`, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer token-${activeUserId}`,
      },
    });

    const body = await res.json();
    assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, true);
  });
});
