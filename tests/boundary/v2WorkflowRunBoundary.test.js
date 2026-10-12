import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import v2WorkflowsRouter from "../../routes/v2/workflows.js";
import { RunRepository } from "../../src/v2/runner/runRepository.js";
import { supabase } from "../../lib/supabase.js";

describe("V2 Workflow Run Security & Boundary Tests (Task T3)", () => {
  let server;
  let baseUrl;
  let origGetUser;
  const testSecret = "test-internal-secret-phase0-t3";
  const originalSecret = process.env.INTERNAL_SECRET;
  const originalFlag = process.env.ENABLE_V2_WORKFLOW_RUN_ENDPOINT;

  // Spy on runRepo
  let originalGetRun;
  let originalListNodeRuns;

  before(async () => {
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
    app.use("/api/v2/workflows", v2WorkflowsRouter);
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
    process.env.INTERNAL_SECRET = originalSecret;
    if (originalFlag !== undefined) {
      process.env.ENABLE_V2_WORKFLOW_RUN_ENDPOINT = originalFlag;
    } else {
      delete process.env.ENABLE_V2_WORKFLOW_RUN_ENDPOINT;
    }
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    setTimeout(() => process.exit(0), 100);
  });

  beforeEach(() => {
    delete process.env.ENABLE_V2_WORKFLOW_RUN_ENDPOINT;
    originalGetRun = RunRepository.prototype.getRun;
    originalListNodeRuns = RunRepository.prototype.listNodeRuns;
  });

  afterEach(() => {
    RunRepository.prototype.getRun = originalGetRun;
    RunRepository.prototype.listNodeRuns = originalListNodeRuns;
  });

  // ── TEST 1: Default configuration rejects POST /api/v2/workflows/run with 404 ──
  it("TEST 1: Default config: POST /api/v2/workflows/run is disabled and returns 404", async () => {
    delete process.env.ENABLE_V2_WORKFLOW_RUN_ENDPOINT;

    const res = await fetch(`${baseUrl}/api/v2/workflows/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-attacker",
      },
      body: JSON.stringify({
        workflow_id: "image-generation-v1",
        input: {
          prompt: "An uncharged malicious run",
        },
      }),
    });

    const body = await res.json();
    assert.strictEqual(res.status, 404, `Expected HTTP 404 for disabled endpoint, got ${res.status}: ${JSON.stringify(body)}`);
    assert.strictEqual(body.code, "ENDPOINT_DISABLED");
  });

  // ── TEST 2: When enabled explicitly via feature flag, endpoint allows execution ──
  it("TEST 2: Feature flag enabled: allows execution only when ENABLE_V2_WORKFLOW_RUN_ENDPOINT=true", async () => {
    process.env.ENABLE_V2_WORKFLOW_RUN_ENDPOINT = "true";

    const res = await fetch(`${baseUrl}/api/v2/workflows/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-admin",
      },
      body: JSON.stringify({
        workflow_id: "non-existent-workflow",
        input: {
          prompt: "Test",
        },
      }),
    });

    const body = await res.json();
    // It passed the feature flag check and reached registry resolution
    assert.notStrictEqual(body.code, "ENDPOINT_DISABLED", "Should not be blocked by feature flag when enabled");
    assert.strictEqual(body.code, "WORKFLOW_NOT_FOUND");
  });

  // ── TEST 3: GET /runs/:run_id enforces user ownership ──
  it("TEST 3: GET /runs/:run_id returns 404 when requested by a different user", async () => {
    RunRepository.prototype.getRun = async (runId) => {
      if (runId === "run-owned-by-user-A") {
        return {
          id: "run-owned-by-user-A",
          user_id: "user-A",
          status: "completed",
        };
      }
      return null;
    };

    const res = await fetch(`${baseUrl}/api/v2/workflows/runs/run-owned-by-user-A`, {
      method: "GET",
      headers: {
        "Authorization": "Bearer token-user-B", // DIFFERENT USER!
      },
    });

    const body = await res.json();
    assert.strictEqual(res.status, 404, `Expected HTTP 404 for unowned run, got ${res.status}`);
    assert.strictEqual(body.code, "RUN_NOT_FOUND");
  });
});
