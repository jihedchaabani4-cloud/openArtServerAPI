import { describe, it, beforeEach, afterEach, before, after } from "node:test";
import assert from "node:assert/strict";
import { WorkflowRepository } from "#generation/tools";
import { WorkflowAuthorizationService } from "../../../src/systems/generation/internal/services/WorkflowAuthorizationService.js";
import { ResolveRefsNode } from "../../../src/systems/generation/internal/v3/index.js";
import express from "express";
import http from "node:http";
import { workflowsRouter, imagesRouter, videoRouter } from "#generation/api";
import { db, executionEngine, elementService, workflowMediaService } from "../../../src/container.js";
import { rateLimitRedisConnection, redisConnection, workerRedisConnection } from "#shared";
import { supabase } from "#shared/db/supabase.js";
import { resetLimitersForTest, toMediaIdList } from "#identity/tools";
import apiRouter from "../../../src/api/routes.js";

// ─── Source: workflowAuthorizationFailClosed.test.js ───
{
process.env.NODE_ENV = "test";


/**
 * Chainable fake of the Supabase query builder, per table:
 *   client().from("workflow").select(...).in("id", ids)  → awaited result
 *   client().from("media").select(...).eq(...).maybeSingle() → awaited result
 */
function fakeDb({ workflowRows, workflowError, mediaRow, mediaError, wfAsMediaRow, wfAsMediaError }) {
    const build = () => {
        const builder = {};
        const finishArr = () => ({ data: workflowRows || [], error: workflowError || null });
        builder.select = () => builder;
        builder.eq = () => builder;
        builder.in = async () => finishArr();
        builder.maybeSingle = () => {};
        builder.maybeSingle = async () => ({ data: mediaRow ?? wfAsMediaRow ?? null, error: (mediaError || wfAsMediaError) || null });
        return builder;
    };
    return {
        media: {
            findMediaOwnershipRecord: async () => {
                if (mediaError) throw mediaError;
                return mediaRow ?? null;
            },
        },
        workflows: { client: () => ({ from: () => build() }) },
    };
}

function makeService(tables) {
    return new WorkflowAuthorizationService({ db: tables });
}

describe("WorkflowAuthorizationService — fail-closed ownership", () => {
    let origBypass;
    beforeEach(() => {
        origBypass = process.env.DEV_AUTH_BYPASS;
        delete process.env.DEV_AUTH_BYPASS;
    });
    afterEach(() => {
        if (origBypass !== undefined) process.env.DEV_AUTH_BYPASS = origBypass;
    });

    describe("verifyWorkflowOwnershipBulk", () => {
        it("authorizes records owned by the requesting user", async () => {
            const service = makeService(fakeDb({
                workflowRows: [
                    { id: "wf-1", project: { user_id: "user-A" } },
                    { id: "wf-2", project: { user_id: "user-A" } },
                ],
            }));
            const owned = await service.verifyWorkflowOwnershipBulk(["wf-1", "wf-2"], "user-A");
            assert.deepEqual(owned, ["wf-1", "wf-2"]);
        });

        it("rejects everything when one record is owned by another user", async () => {
            const service = makeService(fakeDb({
                workflowRows: [
                    { id: "wf-1", project: { user_id: "user-A" } },
                    { id: "wf-2", project: { user_id: "user-B" } },
                ],
            }));
            assert.equal(await service.verifyWorkflowOwnershipBulk(["wf-1", "wf-2"], "user-A"), null);
        });

        it("rejects records whose project has no owner (NULL user_id)", async () => {
            const service = makeService(fakeDb({
                workflowRows: [{ id: "wf-1", project: { user_id: null } }],
            }));
            const owned = await service.verifyWorkflowOwnershipBulk(["wf-1"], "user-A");
            assert.equal(owned === null || owned?.length === 0, true, "null-owner workflows must not authorize any user");
        });

        it("rejects records missing from the database", async () => {
            const service = makeService(fakeDb({ workflowRows: [] }));
            assert.equal(await service.verifyWorkflowOwnershipBulk(["wf-ghost"], "user-A"), null);
        });

        it("propagates database errors instead of turning them into authorization results", async () => {
            const service = makeService(fakeDb({ workflowRows: [], workflowError: new Error("connection reset") }));
            await assert.rejects(
                async () => service.verifyWorkflowOwnershipBulk(["wf-1"], "user-A"),
                /connection reset/
            );
        });
    });

    describe("verifyMediaOwnership", () => {
        it("authorizes media owned by the requesting user", async () => {
            const service = makeService(fakeDb({ mediaRow: { id: "m-1", project: { user_id: "user-A" } } }));
            assert.equal(await service.verifyMediaOwnership("m-1", "user-A"), true);
        });

        it("rejects media owned by another user", async () => {
            const service = makeService(fakeDb({ mediaRow: { id: "m-1", project: { user_id: "user-B" } } }));
            assert.equal(await service.verifyMediaOwnership("m-1", "user-A"), false);
        });

        it("rejects media whose project has no owner (NULL user_id)", async () => {
            const service = makeService(fakeDb({ mediaRow: { id: "m-1", project: { user_id: null } } }));
            assert.equal(await service.verifyMediaOwnership("m-1", "user-A"), false);
        });

        it("rejects media and owner-workflow lookups that resolve to nothing", async () => {
            const service = makeService(fakeDb({})); // no media row, no workflow row
            assert.equal(await service.verifyMediaOwnership("m-ghost", "user-A"), false);
        });

        it("still authorizes a media_id that resolves to the user's own workflow", async () => {
            const service = makeService(fakeDb({ wfAsMediaRow: { id: "wf-1", project: { user_id: "user-A" } } }));
            assert.equal(await service.verifyMediaOwnership("wf-1", "user-A"), true);
        });

        it("rejects a media_id that resolves to a foreign workflow", async () => {
            const service = makeService(fakeDb({ wfAsMediaRow: { id: "wf-1", project: { user_id: "user-B" } } }));
            assert.equal(await service.verifyMediaOwnership("wf-1", "user-A"), false);
        });

        it("propagates database errors instead of authorizing by default", async () => {
            const service = makeService(fakeDb({ mediaError: new Error("timeout reading media") }));
            await assert.rejects(
                async () => service.verifyMediaOwnership("m-1", "user-A"),
                /timeout reading media/
            );
        });
    });
});
}

// ─── Source: collectionItemOwnershipBoundary.test.js ───
{
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
  it("TEST 4: Owner calling PATCH /api/workflows/items/:id/like returns 501 NOT_SUPPORTED", async () => {
    activeUserId = "user-alice"; // Alice toggles like on her own item

    const res = await fetch(`${baseUrl}/api/workflows/items/item-alice-1/like`, {
      method: "PATCH",
      headers: {
        "Authorization": `Bearer token-${activeUserId}`,
      },
    });

    const body = await res.json();
    assert.equal(res.status, 501, `Expected 501, got ${res.status}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, false);
    assert.equal(body.errorCode, "NOT_SUPPORTED");
  });
});
}

// ─── Source: referenceAndMediaOwnershipBoundary.test.js ───
{
describe("Reference and Media Ownership Security & Boundary Tests (Task T2c)", () => {
  let server;
  let baseUrl;
  let origGetUser;

  // Spies and original methods
  let originalFindByUser;
  let originalCreateWorkflow;
  let originalFindWorkflowById;
  let originalGetWorkflow;
  let originalGetPrimaryMediaUrl;
  let originalGetPrimaryMedia;
  let originalCreateMedia;
  let originalFindMediaByIdOrWorkflow;
  let originalFindMediaById;
  let originalFindByWorkflow;
  let originalFindByCharacterId;
  let originalResolveRecord;
  let originalLaunch;

  let workflowCreationCalls = [];
  let mediaCreationCalls = [];
  let enqueueCalls = [];

  before(async () => {
    process.env.NODE_ENV = process.env.NODE_ENV || "test";
    origGetUser = supabase.auth.getUser;
    supabase.auth.getUser = async (token) => {
      if (token === "token-user-A") return { data: { user: { id: "user-A" } }, error: null };
      if (token === "token-user-B") return { data: { user: { id: "user-B" } }, error: null };
      return { data: { user: null }, error: new Error("Invalid token") };
    };

    const app = express();
    app.use(express.json());
    app.use("/api/images", imagesRouter);
    app.use("/api/video", videoRouter);
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

  beforeEach(() => {
    originalFindByUser = db.projects?.findByUser;
    originalCreateWorkflow = db.workflows?.createWorkflow;
    originalFindWorkflowById = db.workflows?.findById;
    originalGetWorkflow = db.workflows?.getWorkflow;
    originalGetPrimaryMediaUrl = db.workflows?.getPrimaryMediaUrl;
    originalGetPrimaryMedia = db.workflows?.getPrimaryMedia;
    originalCreateMedia = db.media?.createMedia;
    originalFindMediaByIdOrWorkflow = db.media?.findMediaByIdOrWorkflow;
    originalFindMediaById = db.media?.findById;
    originalFindByWorkflow = db.media?.findByWorkflow;
    originalFindByCharacterId = db.characters?.findByCharacterId;
    originalResolveRecord = db.elements?.resolveRecord;
    originalLaunch = executionEngine?.launch;

    workflowCreationCalls = [];
    mediaCreationCalls = [];
    enqueueCalls = [];

    // Projects:
    // User A owns "proj-user-A"
    // User B owns "proj-user-B"
    if (db.projects) {
      db.projects.findByUser = async (userId, projectId = null) => {
        const owned = [];
        if (userId === "user-A") owned.push({ id: "proj-user-A", user_id: "user-A" });
        if (userId === "user-B") owned.push({ id: "proj-user-B", user_id: "user-B" });
        if (projectId) return owned.filter((p) => p.id === projectId);
        return owned;
      };
    }

    // Workflows:
    // "wf-user-A" belongs to "proj-user-A" (User A)
    // "wf-user-B" belongs to "proj-user-B" (User B)
    if (db.workflows) {
      db.workflows.createWorkflow = async (data) => {
        workflowCreationCalls.push(data);
        return { ...data, create_time: new Date().toISOString() };
      };

      db.workflows.findById = async (id) => {
        if (id === "wf-user-A") {
          return { id: "wf-user-A", project_id: "proj-user-A", workflow_type: "GENERATION", primary_media_id: "media-user-A" };
        }
        if (id === "wf-char-user-A") {
          return { id: "wf-char-user-A", project_id: "proj-user-A", workflow_type: "CHARACTER_SHEET" };
        }
        if (id === "wf-user-B") {
          return { id: "wf-user-B", project_id: "proj-user-B", workflow_type: "GENERATION", primary_media_id: "media-user-B" };
        }
        return null;
      };

      db.workflows.getWorkflow = db.workflows.findById;

      db.workflows.getPrimaryMediaUrl = async (id) => {
        if (id === "wf-user-A") return "https://cdn.example.com/user-a-primary.png";
        if (id === "wf-user-B") return "https://cdn.example.com/user-b-primary.png";
        return null;
      };
    }

    // Media:
    // "media-user-A" belongs to "proj-user-A"
    // "media-user-B" belongs to "proj-user-B"
    if (db.media) {
      db.media.createMedia = async (data) => {
        mediaCreationCalls.push(data);
        return { ...data, create_time: new Date().toISOString() };
      };

      db.media.findMediaByIdOrWorkflow = async (id) => {
        if (id === "media-user-A" || id === "wf-user-A") {
          return {
            id: "media-user-A",
            workflow_id: "wf-user-A",
            project_id: "proj-user-A",
            url: "https://cdn.example.com/user-a.png",
          };
        }
        if (id === "media-user-B" || id === "wf-user-B") {
          return {
            id: "media-user-B",
            workflow_id: "wf-user-B",
            project_id: "proj-user-B",
            url: "https://cdn.example.com/user-b.png",
          };
        }
        return null;
      };

      db.media.findById = async (id) => {
        return db.media.findMediaByIdOrWorkflow(id);
      };

      db.media.findByWorkflow = async (workflowId) => {
        if (workflowId === "wf-char-user-A" || workflowId === "char-user-A") {
          return [
            { id: "m1", workflow_id: workflowId, step_id: "character_sheet", url: "https://cdn.example.com/char-a-sheet.png" },
          ];
        }
        return [];
      };
    }

    // Characters:
    // "char-user-A" belongs to "proj-user-A" (User A)
    if (db.characters) {
      db.characters.findByCharacterId = async (id) => {
        if (id === "char-user-A" || id === "wf-char-user-A") {
          return {
            id: "char-user-A",
            workflow_id: "wf-char-user-A",
            project_id: "proj-user-A",
            name: "Alice Secret",
            description: "A top secret agent",
            traits: ["stealth", "black hair"],
          };
        }
        return null;
      };
    }

    if (executionEngine) {
      executionEngine.launch = async (params) => {
        enqueueCalls.push(params);
        return {
          jobId: "mock-job-t2c",
          executionId: params.executionId,
          cost: { totalCredits: 10 },
        };
      };
    }
  });

  afterEach(() => {
    if (db.projects) db.projects.findByUser = originalFindByUser;
    if (db.workflows) {
      db.workflows.createWorkflow = originalCreateWorkflow;
      db.workflows.findById = originalFindWorkflowById;
      db.workflows.getWorkflow = originalGetWorkflow;
      db.workflows.getPrimaryMediaUrl = originalGetPrimaryMediaUrl;
      db.workflows.getPrimaryMedia = originalGetPrimaryMedia;
    }
    if (db.media) {
      db.media.createMedia = originalCreateMedia;
      db.media.findMediaByIdOrWorkflow = originalFindMediaByIdOrWorkflow;
      db.media.findById = originalFindMediaById;
      db.media.findByWorkflow = originalFindByWorkflow;
    }
    if (db.characters) db.characters.findByCharacterId = originalFindByCharacterId;
    if (db.elements) db.elements.resolveRecord = originalResolveRecord;
    if (executionEngine) executionEngine.launch = originalLaunch;
  });

  // ── TEST 1: Image Generation Controller - Cross-Tenant Reference in references[] ──
  it("TEST 1: Image Gen: User B referencing User A's character returns 404 and prevents generation", async () => {
    const res = await fetch(`${baseUrl}/api/images/generated`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-B",
      },
      body: JSON.stringify({
        prompt: "A photo of Alice",
        model: "nanobana_pro",
        project_id: "proj-user-B",
        references: ["char-user-A"],
      }),
    });

    const body = await res.json();
    assert.strictEqual(res.status, 404, `Expected 404, got ${res.status}: ${JSON.stringify(body)}`);
    assert.strictEqual(workflowCreationCalls.length, 0, "No workflow should be created for unauthorized reference");
    assert.strictEqual(mediaCreationCalls.length, 0, "No media should be created");
    assert.strictEqual(enqueueCalls.length, 0, "No job should be enqueued");
  });

  // ── TEST 2: Image Generation Controller - Cross-Tenant Input Image in parameters ──
  it("TEST 2: Image Gen: User B using User A's media as input_image returns 404 and prevents generation", async () => {
    const res = await fetch(`${baseUrl}/api/images/generated`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-B",
      },
      body: JSON.stringify({
        prompt: "Edit this photo",
        model: "nanobana_pro",
        project_id: "proj-user-B",
        parameters: {
          input_image: "media-user-A",
        },
      }),
    });

    const body = await res.json();
    assert.strictEqual(res.status, 404, `Expected 404, got ${res.status}: ${JSON.stringify(body)}`);
    assert.strictEqual(workflowCreationCalls.length, 0, "No workflow should be created");
    assert.strictEqual(enqueueCalls.length, 0, "No job should be enqueued");
  });

  // ── TEST 3: Video Generation Controller - Cross-Tenant Input Media ──
  it("TEST 3: Video Gen: User B using User A's media as input_image or references returns 404 and prevents generation", async () => {
    const res = await fetch(`${baseUrl}/api/video/generated`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-B",
      },
      body: JSON.stringify({
        prompt: "Animate this photo",
        model: "wan_3_0",
        project_id: "proj-user-B",
        parameters: {
          input_image: "wf-user-A",
        },
      }),
    });

    const body = await res.json();
    assert.strictEqual(res.status, 404, `Expected 404, got ${res.status}: ${JSON.stringify(body)}`);
    assert.strictEqual(workflowCreationCalls.length, 0, "No workflow should be created");
    assert.strictEqual(enqueueCalls.length, 0, "No job should be enqueued");
  });

  // ── TEST 6: V3 ResolveRefsNode ignores unowned references ──
  it("TEST 6: V3 ResolveRefsNode: unowned references are discarded and not injected into prepared_prompt", async () => {
    const resolvedRefs = await ResolveRefsNode.execute(
      {
        prompt: "Portrait of",
        references: [{ id: "char-user-A" }],
      },
      {
        nodeId: "test-resolve",
        runId: "run-t2c-1",
        userId: "user-B",
      }
    );

    // User A's character should NOT be resolved for User B
    assert.strictEqual(resolvedRefs.entities.length, 0, "Entities list must be empty because User B does not own char-user-A");
    assert.strictEqual(resolvedRefs.reference_urls.length, 0, "No image URLs should be extracted from unowned entity");
    assert.ok(!resolvedRefs.prepared_prompt.includes("Alice Secret"), "Prepared prompt must not leak User A's character name");
    assert.strictEqual(resolvedRefs.prepared_prompt.trim(), "Portrait of");
  });

  // ── TEST 7: Legitimate owner (User A) operations succeed ──
  it("TEST 7: Legitimate Owner: User A referencing own character and media succeeds", async () => {
    // Image Gen HTTP request succeeds for owner
    const res = await fetch(`${baseUrl}/api/images/generated`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-A",
      },
      body: JSON.stringify({
        prompt: "A photo of Alice",
        model: "nanobana_pro",
        project_id: "proj-user-A",
        references: ["char-user-A"],
        parameters: {
          input_image: "media-user-A",
        },
      }),
    });

    const body = await res.json();
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    assert.strictEqual(workflowCreationCalls.length, 1, "Workflow created for legitimate owner");
    assert.strictEqual(enqueueCalls.length, 1, "Job enqueued for legitimate owner");
  });

  // ── TEST 8 (OWN-IMG-1): Image Gen - parameters.images as a STRING with User A's ID ──
  it("TEST 8 (OWN-IMG-1): Image Gen: parameters.images as a STRING with User A's ID returns 404 and creates no records/holds", async () => {
    const res = await fetch(`${baseUrl}/api/images/generated`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-B",
      },
      body: JSON.stringify({
        prompt: "Use another user's image via string",
        model: "nanobana_pro",
        project_id: "proj-user-B",
        parameters: {
          images: "media-user-A",
        },
      }),
    });

    const body = await res.json();
    assert.strictEqual(res.status, 404, `Expected 404, got ${res.status}: ${JSON.stringify(body)}`);
    assert.strictEqual(workflowCreationCalls.length, 0, "No workflow should be created");
    assert.strictEqual(mediaCreationCalls.length, 0, "No media placeholder should be created");
    assert.strictEqual(enqueueCalls.length, 0, "No credit hold / job enqueue should happen");
    assert.ok(!JSON.stringify(body).includes("cdn.example.com"), "Response body must not reveal record URL");
    assert.ok(!JSON.stringify(body).includes("proj-user-A"), "Response body must not reveal owner project");
  });

  // ── TEST 9 (OWN-IMG-1): Image Gen - parameters.images as an ARRAY and [{ workflow_id }] ──
  it("TEST 9 (OWN-IMG-1): Image Gen: parameters.images as ARRAY, [{ workflow_id }], and { workflow_id } with User A's ID returns 404", async () => {
    const shapes = [
      ["media-user-A"],
      [{ workflow_id: "wf-user-A" }],
      { workflow_id: "wf-user-A" },
    ];

    for (const imagesShape of shapes) {
      if (process.env.NODE_ENV === "test") resetLimitersForTest();
      const res = await fetch(`${baseUrl}/api/images/generated`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer token-user-B",
        },
        body: JSON.stringify({
          prompt: "Use another user's image",
          model: "nanobana_pro",
          project_id: "proj-user-B",
          parameters: {
            images: imagesShape,
          },
        }),
      });

      const body = await res.json();
      assert.strictEqual(
        res.status,
        404,
        `Shape ${JSON.stringify(imagesShape)} expected 404, got ${res.status}: ${JSON.stringify(body)}`
      );
      assert.strictEqual(workflowCreationCalls.length, 0, "No workflow should be created");
      assert.strictEqual(mediaCreationCalls.length, 0, "No media should be created");
      assert.strictEqual(enqueueCalls.length, 0, "No job should be enqueued");
    }
  });

  // ── TEST 10 (OWN-IMG-1): Image Gen - other media keys (reference_images, input_image as array, top-level references as string) ──
  it("TEST 10 (OWN-IMG-1): Image Gen: reference_images (string/array), input_image (array/object), and top-level references (string) with User A's ID return 404", async () => {
    const payloads = [
      { parameters: { reference_images: "wf-user-A" } },
      { parameters: { reference_images: ["wf-user-A"] } },
      { parameters: { input_image: ["media-user-A"] } },
      { parameters: { input_image: { workflow_id: "wf-user-A" } } },
      { references: "char-user-A" },
    ];

    for (const extra of payloads) {
      if (process.env.NODE_ENV === "test") resetLimitersForTest();
      const res = await fetch(`${baseUrl}/api/images/generated`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer token-user-B",
        },
        body: JSON.stringify({
          prompt: "Cross-tenant media key check",
          model: "nanobana_pro",
          project_id: "proj-user-B",
          ...extra,
        }),
      });

      const body = await res.json();
      assert.strictEqual(
        res.status,
        404,
        `Payload ${JSON.stringify(extra)} expected 404, got ${res.status}: ${JSON.stringify(body)}`
      );
      assert.strictEqual(workflowCreationCalls.length, 0, "No workflow should be created");
      assert.strictEqual(mediaCreationCalls.length, 0, "No media should be created");
      assert.strictEqual(enqueueCalls.length, 0, "No job should be enqueued");
    }
  });

  // ── TEST 11 (OWN-IMG-1): Video Gen - all media keys across string, array, and object shapes ──
  it("TEST 11 (OWN-IMG-1): Video Gen: images, reference_images, reference_videos, input_image, last_frame, input_video (string/array/object) with User A's ID return 404", async () => {
    const payloads = [
      { parameters: { images: "wf-user-A" } },
      { parameters: { images: ["wf-user-A"] } },
      { parameters: { images: [{ workflow_id: "wf-user-A" }] } },
      { parameters: { images: { workflow_id: "wf-user-A" } } },
      { parameters: { reference_images: "wf-user-A" } },
      { parameters: { reference_images: ["wf-user-A"] } },
      { parameters: { reference_videos: "wf-user-A" } },
      { parameters: { reference_videos: ["wf-user-A"] } },
      { parameters: { last_frame: "wf-user-A" } },
      { parameters: { last_frame: ["wf-user-A"] } },
      { parameters: { input_video: "wf-user-A" } },
      { parameters: { input_video: ["wf-user-A"] } },
      { references: "char-user-A" },
    ];

    for (const extra of payloads) {
      if (process.env.NODE_ENV === "test") resetLimitersForTest();
      const res = await fetch(`${baseUrl}/api/video/generated`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer token-user-B",
        },
        body: JSON.stringify({
          prompt: "Animate cross-tenant media",
          model: "wan_3_0",
          project_id: "proj-user-B",
          ...extra,
        }),
      });

      const body = await res.json();
      assert.strictEqual(
        res.status,
        404,
        `Video payload ${JSON.stringify(extra)} expected 404, got ${res.status}: ${JSON.stringify(body)}`
      );
      assert.strictEqual(workflowCreationCalls.length, 0, "No video workflow should be created");
      assert.strictEqual(mediaCreationCalls.length, 0, "No video media should be created");
      assert.strictEqual(enqueueCalls.length, 0, "No video job should be enqueued");
    }
  });

  // ── TEST 12 (OWN-IMG-1): Legitimate Owner (User A) with string and array images succeeds ──
  it("TEST 12 (OWN-IMG-1): Legitimate Owner: User A with parameters.images as a STRING and as an ARRAY both return 200", async () => {
    // 12a. String images
    const resStr = await fetch(`${baseUrl}/api/images/generated`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-A",
      },
      body: JSON.stringify({
        prompt: "Legitimate owner with string images",
        model: "nanobana_pro",
        project_id: "proj-user-A",
        parameters: {
          images: "media-user-A",
        },
      }),
    });
    const bodyStr = await resStr.json();
    assert.strictEqual(resStr.status, 200, `Expected 200 for string images, got ${resStr.status}: ${JSON.stringify(bodyStr)}`);
    assert.deepStrictEqual(
      enqueueCalls[0]?.input?.parameters?.images,
      ["media-user-A"],
      "String parameters.images must be normalized to array ['media-user-A'] at boundary"
    );

    // 12b. Array images
    const resArr = await fetch(`${baseUrl}/api/images/generated`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-A",
      },
      body: JSON.stringify({
        prompt: "Legitimate owner with array images",
        model: "nanobana_pro",
        project_id: "proj-user-A",
        parameters: {
          images: ["media-user-A"],
        },
      }),
    });
    const bodyArr = await resArr.json();
    assert.strictEqual(resArr.status, 200, `Expected 200 for array images, got ${resArr.status}: ${JSON.stringify(bodyArr)}`);
    assert.deepStrictEqual(
      enqueueCalls[1]?.input?.parameters?.images,
      ["media-user-A"],
      "Array parameters.images stays ['media-user-A']"
    );
  });

  // ── TEST 13 (OWN-IMG-2): Shared helper toMediaIdList normalizes string, array, object, and invalid inputs ──
  it("TEST 13 (OWN-IMG-2): toMediaIdList normalizes strings, arrays, objects, and ignores empty/non-media values", () => {
    assert.deepStrictEqual(toMediaIdList("media-user-A"), ["media-user-A"]);
    assert.deepStrictEqual(toMediaIdList("  wf-user-A  "), ["wf-user-A"]);
    assert.deepStrictEqual(toMediaIdList(["media-user-A", { workflow_id: "wf-user-A" }, { id: "id-3" }]), [
      "media-user-A",
      "wf-user-A",
      "id-3",
    ]);
    assert.deepStrictEqual(toMediaIdList({ workflow_id: "wf-user-A" }), ["wf-user-A"]);
    assert.deepStrictEqual(toMediaIdList(""), []);
    assert.deepStrictEqual(toMediaIdList(null), []);
    assert.deepStrictEqual(toMediaIdList(undefined), []);
    assert.deepStrictEqual(toMediaIdList(42), []);
  });
});
}

// ─── Source: workflowUserIdAndFolderHardening.test.js ───
{
process.env.NODE_ENV = "test";

describe("Workflow user_id Persistence, updateFolderId Hardening, and UUID Validation (P3 Fix)", () => {
  let server;
  let baseUrl;
  let origGetUser;

  let projects = [];
  let folders = [];
  let workflows = [];

  before(async () => {
    origGetUser = supabase.auth.getUser;
    supabase.auth.getUser = async (token) => {
      if (token === "token-user-A") return { data: { user: { id: "00000000-0000-0000-0000-000000000001" } }, error: null };
      if (token === "token-user-B") return { data: { user: { id: "00000000-0000-0000-0000-000000000002" } }, error: null };
      return { data: { user: null }, error: new Error("Invalid token") };
    };

    const app = express();
    app.use(express.json());
    app.use("/api", apiRouter);
    app.use("/api/images", imagesRouter);
    app.use("/api/video", videoRouter);
    app.use((err, req, res, next) => {
      res.status(err.statusCode || 500).json({
        ok: false,
        message: err.message,
        code: err.errorCode || err.code || "INTERNAL_ERROR",
      });
    });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

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

  beforeEach(() => {
    const userA = "00000000-0000-0000-0000-000000000001";
    const userB = "00000000-0000-0000-0000-000000000002";
    const projA = "11111111-1111-1111-1111-111111111111";
    const projB = "22222222-2222-2222-2222-222222222222";
    const folderA = "33333333-3333-3333-3333-333333333333";

    projects = [
      { id: projA, user_id: userA, name: "Project A" },
      { id: projB, user_id: userB, name: "Project B" },
    ];

    folders = [
      {
        id: folderA,
        project_id: projA,
        user_id: userA,
        parent_id: null,
        name: "Folder A",
        position: 0,
      },
    ];

    workflows = [
      {
        id: "44444444-4444-4444-4444-444444444444",
        project_id: projA,
        user_id: null, // Legacy / unpopulated user_id
        folder_id: null,
        display_name: "Legacy Workflow",
        create_time: new Date().toISOString(),
      },
    ];

    db.projects.findByUser = async (userId, projectId) => {
      const p = projects.find((proj) => proj.id === projectId && proj.user_id === userId);
      return p ? [p] : [];
    };
    db.projects.findById = async (projectId) => {
      return projects.find((proj) => proj.id === projectId) || null;
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

    db.workflows.findById = async (id) => {
      return workflows.find((w) => w.id === id) || null;
    };
    db.workflows.getWorkflow = async (id) => {
      return workflows.find((w) => w.id === id) || null;
    };
    db.workflows.updateFolderId = async (workflowId, folderId, userId, projectId) => {
      if (!workflowId || !userId || !projectId) {
        throw new Error("workflowId, userId, and projectId are required");
      }
      const wf = workflows.find((w) => w.id === workflowId && w.project_id === projectId);
      if (!wf) {
        const err = new Error("Not found");
        err.code = "PGRST116";
        err.statusCode = 404;
        throw err;
      }
      wf.folder_id = folderId;
      wf.user_id = userId;
      return wf;
    };
  });

  describe("1. Workflow user_id population on creation", () => {
    it("ElementService.createElement sets user_id on created workflow row", async () => {
      let createdWf = null;
      const origCreate = db.workflows.createWorkflow;
      db.workflows.createWorkflow = async (data) => {
        createdWf = data;
        return { id: "elem-wf-1", ...data };
      };

      const origAddRef = elementService.mediaService.addReferenceMedia;
      elementService.mediaService.addReferenceMedia = async () => ({
        media: { id: "m-1" },
        url: null,
      });
      const origAnalysis = elementService.analysisService;
      elementService.analysisService = null;
      const origElCreate = db.elements.create;
      db.elements.create = async (d) => d;

      try {
        await elementService.createElement({
          name: "Test Element",
          sourceImages: [{ url: "https://example.com/img.jpg", purpose: "source" }],
          projectId: "11111111-1111-1111-1111-111111111111",
          userId: "00000000-0000-0000-0000-000000000001",
        });

        assert.ok(createdWf, "createWorkflow was called");
        assert.equal(createdWf.user_id, "00000000-0000-0000-0000-000000000001", "user_id must be populated from authenticated user");
      } finally {
        db.workflows.createWorkflow = origCreate;
        elementService.mediaService.addReferenceMedia = origAddRef;
        elementService.analysisService = origAnalysis;
        db.elements.create = origElCreate;
      }
    });

    it("WorkflowMediaService.detachMedia sets user_id on created standalone workflow row", async () => {
      let createdWf = null;
      const origCreate = db.workflows.createWorkflow;
      db.workflows.createWorkflow = async (data) => {
        createdWf = data;
        return { id: "detached-wf-1", ...data };
      };

      const origAuth = workflowMediaService.authService.verifyMediaOwnership;
      workflowMediaService.authService.verifyMediaOwnership = async () => true;

      const origMediaFindById = db.media.findById;
      db.media.findById = async () => ({
        id: "media-1",
        workflow_id: "old-wf",
        status: "completed",
        user_id: "00000000-0000-0000-0000-000000000001",
        project_id: "11111111-1111-1111-1111-111111111111",
      });

      const origMediaUpdate = db.media.updateFields;
      db.media.updateFields = async () => ({});
      const origWfUpdate = db.workflows.updateFields;
      db.workflows.updateFields = async () => ({});
      const origFindById = db.workflows.findById;
      db.workflows.findById = async () => null;

      try {
        await workflowMediaService.detachMedia({
          mediaId: "media-1",
          userId: "00000000-0000-0000-0000-000000000001",
          projectId: "11111111-1111-1111-1111-111111111111",
        });

        assert.ok(createdWf, "createWorkflow was called");
        assert.equal(createdWf.user_id, "00000000-0000-0000-0000-000000000001", "user_id must be populated on detached workflow");
      } finally {
        db.workflows.createWorkflow = origCreate;
        workflowMediaService.authService.verifyMediaOwnership = origAuth;
        db.media.findById = origMediaFindById;
        db.media.updateFields = origMediaUpdate;
        db.workflows.updateFields = origWfUpdate;
        db.workflows.findById = origFindById;
      }
    });
  });

  describe("2. Workflow with user_id NULL in project owned by User A", () => {
    it("User A moves it to User A's folder -> 200", async () => {
      const res = await fetch(`${baseUrl}/api/assets/44444444-4444-4444-4444-444444444444/folder`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ folderId: "33333333-3333-3333-3333-333333333333" }),
      });

      assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
      const body = await res.json();
      assert.equal(body.folderId, "33333333-3333-3333-3333-333333333333");
    });

    it("User B attempts to move it -> 404", async () => {
      const res = await fetch(`${baseUrl}/api/assets/44444444-4444-4444-4444-444444444444/folder`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-B",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ folderId: null }),
      });

      assert.equal(res.status, 404, `Expected 404, got ${res.status}`);
    });
  });

  describe("3. WorkflowRepository.updateFolderId Contract & Error Mapping", () => {
    it("throws if userId or projectId is missing", async () => {
      const repo = new WorkflowRepository();
      await assert.rejects(
        () => repo.updateFolderId("44444444-4444-4444-4444-444444444444", "33333333-3333-3333-3333-333333333333", null, "11111111-1111-1111-1111-111111111111"),
        /required/i
      );
      await assert.rejects(
        () => repo.updateFolderId("44444444-4444-4444-4444-444444444444", "33333333-3333-3333-3333-333333333333", "00000000-0000-0000-0000-000000000001", null),
        /required/i
      );
    });

    it("maps PGRST116 (zero rows updated) to 404 error", async () => {
      const repo = new WorkflowRepository();
      const origClient = repo.client.bind(repo);
      repo.client = () => ({
        from: () => ({
          update: () => ({
            eq: () => ({
              eq: () => ({
                select: () => ({
                  single: async () => ({
                    data: null,
                    error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" },
                  }),
                }),
              }),
            }),
          }),
        }),
      });

      try {
        await assert.rejects(
          () => repo.updateFolderId("44444444-4444-4444-4444-444444444444", null, "00000000-0000-0000-0000-000000000001", "11111111-1111-1111-1111-111111111111"),
          (err) => err.statusCode === 404 && err.code === "PGRST116"
        );
      } finally {
        repo.client = origClient;
      }
    });

    it("maps 23503 (foreign key constraint violation) to 404 error", async () => {
      const repo = new WorkflowRepository();
      const origClient = repo.client.bind(repo);
      repo.client = () => ({
        from: () => ({
          update: () => ({
            eq: () => ({
              eq: () => ({
                select: () => ({
                  single: async () => ({
                    data: null,
                    error: { code: "23503", message: "foreign key constraint violation" },
                  }),
                }),
              }),
            }),
          }),
        }),
      });

      try {
        await assert.rejects(
          () => repo.updateFolderId("44444444-4444-4444-4444-444444444444", "33333333-3333-3333-3333-333333333333", "00000000-0000-0000-0000-000000000001", "11111111-1111-1111-1111-111111111111"),
          (err) => err.statusCode === 404 && err.code === "23503"
        );
      } finally {
        repo.client = origClient;
      }
    });
  });

  describe("4. folderId UUID Validation (invalid -> 400)", () => {
    it("PATCH /api/assets/:assetId/folder rejects non-UUID folderId with 400", async () => {
      const res = await fetch(`${baseUrl}/api/assets/44444444-4444-4444-4444-444444444444/folder`, {
        method: "PATCH",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ folderId: "invalid-not-a-uuid" }),
      });

      assert.equal(res.status, 400, `Expected 400, got ${res.status}`);
    });

    it("POST /api/assets/upload rejects non-UUID folderId with 400", async () => {
      const res = await fetch(`${baseUrl}/api/assets/upload`, {
        method: "POST",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          project_id: "11111111-1111-1111-1111-111111111111",
          folderId: "invalid-not-a-uuid",
          base64: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        }),
      });

      assert.equal(res.status, 400, `Expected 400, got ${res.status}`);
    });

    it("POST /api/images/generated rejects non-UUID folderId with 400", async () => {
      const res = await fetch(`${baseUrl}/api/images/generated`, {
        method: "POST",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectId: "11111111-1111-1111-1111-111111111111",
          folderId: "invalid-not-a-uuid",
          prompt: "test prompt",
          model: "nanobana_2",
        }),
      });

      assert.equal(res.status, 400, `Expected 400, got ${res.status}`);
    });

    it("POST /api/video/generated rejects non-UUID folderId with 400", async () => {
      const res = await fetch(`${baseUrl}/api/video/generated`, {
        method: "POST",
        headers: {
          Authorization: "Bearer token-user-A",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          projectId: "11111111-1111-1111-1111-111111111111",
          folderId: "invalid-not-a-uuid",
          prompt: "test video prompt",
          model: "seedance_v1",
        }),
      });

      assert.equal(res.status, 400, `Expected 400, got ${res.status}`);
    });
  });
});
}
