import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import imagesRouter from "../../routes/images.js";
import { db, useCaseService } from "../../src/container.js";
import { redisConnection, workerRedisConnection } from "../../src/queue/redis.js";
import { supabase } from "../../lib/supabase.js";

describe("RC1.1-R3 — Count Parameter Current Server Behavior Test", () => {
  let server;
  let baseUrl;
  let origGetUser;
  const testSecret = "configured-valid-test-secret-at-least-32-chars";
  let origSecret;

  let createdWorkflows = [];
  let createdMedia = [];
  let enqueueCalls = [];

  let origCreateWorkflow;
  let origCreateMedia;
  let origPrepareAndEnqueue;
  let origProjectsFindByUser;

  after(async () => {
    supabase.auth.getUser = origGetUser;
    process.env.INTERNAL_SECRET = origSecret;
    try {
      await redisConnection?.quit().catch(() => redisConnection?.disconnect());
      await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
    } catch {}
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  before(async () => {
    origSecret = process.env.INTERNAL_SECRET;
    process.env.INTERNAL_SECRET = testSecret;
    origGetUser = supabase.auth.getUser;
    supabase.auth.getUser = async (token) => {
      if (token && token.startsWith("token-")) {
        const userId = token.replace("token-", "");
        return { data: { user: { id: userId } }, error: null };
      }
      return { data: { user: null }, error: new Error("Invalid token") };
    };

    const app = express();
    app.use(express.json());
    app.use("/api/images", imagesRouter);
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
    createdWorkflows = [];
    createdMedia = [];
    enqueueCalls = [];

    origCreateWorkflow = db.workflows.createWorkflow;
    origCreateMedia = db.media.createMedia;
    origPrepareAndEnqueue = useCaseService.prepareAndEnqueue;
    origProjectsFindByUser = db.projects?.findByUser;

    db.projects = {
      ...db.projects,
      findByUser: async (userId, projectId) => [{ id: projectId, user_id: userId }],
    };

    db.workflows.createWorkflow = async (data) => {
      createdWorkflows.push(data);
      return data;
    };

    db.media.createMedia = async (data) => {
      createdMedia.push(data);
      return data;
    };

    useCaseService.prepareAndEnqueue = async (useCaseId, input, opts) => {
      enqueueCalls.push({ useCaseId, input, opts });
      return {
        jobId: "mock-job-count-test",
        taskId: "mock-job-count-test",
        hasSufficientCredits: true,
        calculatedCost: 10,
        billingPlan: { totalCredits: 10 },
      };
    };
  });

  afterEach(() => {
    db.workflows.createWorkflow = origCreateWorkflow;
    db.media.createMedia = origCreateMedia;
    useCaseService.prepareAndEnqueue = origPrepareAndEnqueue;
    if (db.projects) db.projects.findByUser = origProjectsFindByUser;
  });

  it("TEST 1: top-level count: 4 on nanobana_2 today — server clamps silently to 1 placeholder and returns 200", async () => {
    const res = await fetch(`${baseUrl}/api/images/generated`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-test",
      },
      body: JSON.stringify({
        prompt: "A beautiful landscape",
        model: "nanobana_2",
        project_id: "proj-1",
        count: 4, // top-level count
      }),
    });

    const body = await res.json();
    // Server today: does NOT reject with 400 or 422, returns 200
    assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, true);
    // Server today: silently clamps to 1 media placeholder
    assert.equal(body.mediaIds.length, 1, "Server clamped output count to 1");
    assert.equal(createdMedia.length, 1, "Only 1 media placeholder created in DB");
  });

  it("TEST 2: parameters.count: 4 on nanobana_2 today — server clamps silently to 1 placeholder and returns 200", async () => {
    const res = await fetch(`${baseUrl}/api/images/generated`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-test",
      },
      body: JSON.stringify({
        prompt: "A beautiful landscape",
        model: "nanobana_2",
        project_id: "proj-1",
        parameters: {
          count: 4, // inside parameters
        },
      }),
    });

    const body = await res.json();
    // Server today: does NOT reject with 400 or 422, returns 200
    assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    assert.equal(body.ok, true);
    // Server today: silently clamps to 1 media placeholder
    assert.equal(body.mediaIds.length, 1, "Server clamped output count to 1");
    assert.equal(createdMedia.length, 1, "Only 1 media placeholder created in DB");
  });

  it("TEST 3: count: 4 on all catalog image models (gpt_image_2, seedream_v5, nanobana_pro) — all clamp silently to 1", async () => {
    for (const model of ["gpt_image_2", "seedream_v5", "nanobana_pro"]) {
      createdMedia = [];
      const res = await fetch(`${baseUrl}/api/images/generated`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer token-user-test",
        },
        body: JSON.stringify({
          prompt: `Test image for ${model}`,
          model,
          project_id: "proj-1",
          count: 4,
          parameters: { count: 4 },
        }),
      });

      const body = await res.json();
      assert.equal(res.status, 200, `Model ${model} expected 200, got ${res.status}`);
      assert.equal(body.ok, true);
      assert.equal(body.mediaIds.length, 1, `Model ${model} clamped to 1 output`);
      assert.equal(createdMedia.length, 1, `Model ${model} created only 1 placeholder`);
    }
  });
});
