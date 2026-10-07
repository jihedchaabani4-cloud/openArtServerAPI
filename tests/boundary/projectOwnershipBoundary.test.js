import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import imagesRouter from "../../routes/images.js";
import videoRouter from "../../routes/video.js";
import { db, useCaseService } from "../../src/container.js";
import { rateLimitRedisConnection, redisConnection, workerRedisConnection } from "../../src/queue/redis.js";
import { supabase } from "../../lib/supabase.js";

describe("Project Ownership Security & Boundary Tests (Task T2a)", () => {
  let server;
  let baseUrl;
  let origGetUser;

  // Spies and original methods
  let originalFindByUser;
  let originalCreateWorkflow;
  let originalCreateMedia;
  let originalPrepareAndEnqueue;

  let workflowCreationCalls = [];
  let mediaCreationCalls = [];
  let enqueueCalls = [];

  before(async () => {
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
    originalCreateMedia = db.media?.createMedia;
    originalPrepareAndEnqueue = useCaseService?.prepareAndEnqueue;

    workflowCreationCalls = [];
    mediaCreationCalls = [];
    enqueueCalls = [];

    // Mock project database table:
    // User A owns "proj-user-A"
    // User B owns "proj-user-B"
    if (db.projects) {
      db.projects.findByUser = async (userId, projectId = null) => {
        const owned = [];
        if (userId === "user-A") owned.push({ id: "proj-user-A", user_id: "user-A" });
        if (userId === "user-B") owned.push({ id: "proj-user-B", user_id: "user-B" });
        if (projectId) {
          return owned.filter((p) => p.id === projectId);
        }
        return owned;
      };
    }

    if (db.workflows) {
      db.workflows.createWorkflow = async (data) => {
        workflowCreationCalls.push(data);
        return { ...data, create_time: new Date().toISOString() };
      };
    }

    if (db.media) {
      db.media.createMedia = async (data) => {
        mediaCreationCalls.push(data);
        return { ...data, create_time: new Date().toISOString() };
      };
    }

    if (useCaseService) {
      useCaseService.prepareAndEnqueue = async (params) => {
        enqueueCalls.push(params);
        return {
          jobId: "mock-job-123",
          executionId: params.executionId,
          cost: { totalCredits: 10 },
        };
      };
    }
  });

  afterEach(() => {
    if (db.projects && originalFindByUser) db.projects.findByUser = originalFindByUser;
    if (db.workflows && originalCreateWorkflow) db.workflows.createWorkflow = originalCreateWorkflow;
    if (db.media && originalCreateMedia) db.media.createMedia = originalCreateMedia;
    if (useCaseService && originalPrepareAndEnqueue) useCaseService.prepareAndEnqueue = originalPrepareAndEnqueue;
  });

  it("TEST 1: Image: User B using User A's projectId returns 404 and creates NO workflow/media/hold", async () => {
    const res = await fetch(`${baseUrl}/api/images/generated`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-B",
      },
      body: JSON.stringify({
        prompt: "A beautiful sunrise in the mountains",
        model: "nanobana_2",
        project_id: "proj-user-A", // BELONGS TO USER A!
      }),
    });

    const body = await res.json();
    assert.strictEqual(res.status, 404, `Expected HTTP 404 for unowned project but got ${res.status}`);
    assert.strictEqual(body.ok, false);
    assert.match(body.message, /not found/i);

    // Verify Invariants: NO resources created in DB, NO job enqueued
    assert.strictEqual(workflowCreationCalls.length, 0, "No workflow must be created in User A's project");
    assert.strictEqual(mediaCreationCalls.length, 0, "No media placeholder must be created in User A's project");
    assert.strictEqual(enqueueCalls.length, 0, "No useCase job must be enqueued");
  });

  it("TEST 2: Video: User B using User A's projectId returns 404 and creates NO workflow/media/hold", async () => {
    const res = await fetch(`${baseUrl}/api/video/generated`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-B",
      },
      body: JSON.stringify({
        prompt: "A cinematic drone shot flying over a forest",
        model: "wan_3_0",
        project_id: "proj-user-A", // BELONGS TO USER A!
      }),
    });

    const body = await res.json();
    assert.strictEqual(res.status, 404, `Expected HTTP 404 for unowned project but got ${res.status}`);
    assert.strictEqual(body.ok, false);
    assert.match(body.message, /not found/i);

    // Verify Invariants: NO resources created in DB, NO job enqueued
    assert.strictEqual(workflowCreationCalls.length, 0, "No video workflow must be created in User A's project");
    assert.strictEqual(mediaCreationCalls.length, 0, "No video media must be created in User A's project");
    assert.strictEqual(enqueueCalls.length, 0, "No video useCase job must be enqueued");
  });

  it("TEST 3: Image: Legitimate project owner (User A) using proj-user-A succeeds with 200", async () => {
    const res = await fetch(`${baseUrl}/api/images/generated`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-A",
      },
      body: JSON.stringify({
        prompt: "A majestic lion on a cliff",
        model: "nanobana_2",
        project_id: "proj-user-A", // BELONGS TO USER A!
      }),
    });

    const body = await res.json();
    assert.strictEqual(res.status, 200, `Expected HTTP 200 for owned project but got ${res.status}`);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(workflowCreationCalls.length, 1, "Workflow must be created for legitimate owner");
    assert.strictEqual(workflowCreationCalls[0].project_id, "proj-user-A");
    assert.strictEqual(mediaCreationCalls.length, 1, "Media must be created for legitimate owner");
    assert.strictEqual(enqueueCalls.length, 1, "UseCase must be enqueued for legitimate owner");
  });

  it("TEST 4: Video: Legitimate project owner (User A) using proj-user-A succeeds with 200", async () => {
    const res = await fetch(`${baseUrl}/api/video/generated`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-A",
      },
      body: JSON.stringify({
        prompt: "A running stream in a forest",
        model: "wan_3_0",
        project_id: "proj-user-A", // BELONGS TO USER A!
      }),
    });

    const body = await res.json();
    assert.strictEqual(res.status, 200, `Expected HTTP 200 for owned project but got ${res.status}`);
    assert.strictEqual(body.ok, true);
    assert.strictEqual(workflowCreationCalls.length, 1, "Video workflow must be created for legitimate owner");
    assert.strictEqual(workflowCreationCalls[0].project_id, "proj-user-A");
    assert.strictEqual(mediaCreationCalls.length, 1, "Video media must be created for legitimate owner");
    assert.strictEqual(enqueueCalls.length, 1, "Video UseCase must be enqueued for legitimate owner");
  });
});
