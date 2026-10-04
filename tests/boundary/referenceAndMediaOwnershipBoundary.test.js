import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import imagesRouter from "../../routes/images.js";
import videoRouter from "../../routes/video.js";
import { db, useCaseService } from "../../src/container.js";
import {
  resolveWorkflowReference,
  resolveWorkflowReferences,
  resolvePrimaryMediaUrl,
} from "../../src/v2/resolvers/WorkflowReferenceResolver.js";
import { executePromptBuilder } from "../../src/v2/nodes/promptBuilderNode.js";

describe("Reference and Media Ownership Security & Boundary Tests (Task T2c)", () => {
  let server;
  let baseUrl;
  const testSecret = "test-internal-secret-phase0-t2c";
  const originalSecret = process.env.INTERNAL_SECRET;

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
  let originalPrepareAndEnqueue;

  let workflowCreationCalls = [];
  let mediaCreationCalls = [];
  let enqueueCalls = [];

  before(async () => {
    process.env.INTERNAL_SECRET = testSecret;

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
    process.env.INTERNAL_SECRET = originalSecret;
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    setTimeout(() => process.exit(0), 100);
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
    originalPrepareAndEnqueue = useCaseService?.prepareAndEnqueue;

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

    if (useCaseService) {
      useCaseService.prepareAndEnqueue = async (params) => {
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
    if (useCaseService) useCaseService.prepareAndEnqueue = originalPrepareAndEnqueue;
  });

  // ── TEST 1: Image Generation Controller - Cross-Tenant Reference in references[] ──
  it("TEST 1: Image Gen: User B referencing User A's character returns 404 and prevents generation", async () => {
    const res = await fetch(`${baseUrl}/api/images/generated`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": testSecret,
        "x-user-id": "user-B",
      },
      body: JSON.stringify({
        prompt: "A photo of Alice",
        model: "seedream_v5",
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
        "x-internal-secret": testSecret,
        "x-user-id": "user-B",
      },
      body: JSON.stringify({
        prompt: "Edit this photo",
        model: "seedream_v5",
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
        "x-internal-secret": testSecret,
        "x-user-id": "user-B",
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

  // ── TEST 4: WorkflowReferenceResolver.resolveWorkflowReference rejects unowned entity ──
  it("TEST 4: WorkflowReferenceResolver: resolveWorkflowReference returns null when userId does not own entity", async () => {
    // User B tries to resolve User A's character workflow
    const resultChar = await resolveWorkflowReference("wf-char-user-A", "user-B");
    assert.strictEqual(resultChar, null, "Unowned character workflow must resolve to null for User B");

    // User B tries to resolve User A's generation workflow
    const resultGen = await resolveWorkflowReference("wf-user-A", "user-B");
    assert.strictEqual(resultGen, null, "Unowned generation workflow must resolve to null for User B");
  });

  // ── TEST 5: WorkflowReferenceResolver.resolvePrimaryMediaUrl rejects unowned workflow ──
  it("TEST 5: WorkflowReferenceResolver: resolvePrimaryMediaUrl returns null when userId does not own media/workflow", async () => {
    const unownedUrl = await resolvePrimaryMediaUrl("wf-user-A", "user-B");
    assert.strictEqual(unownedUrl, null, "Unowned primary media URL must resolve to null for User B");
  });

  // ── TEST 6: PromptBuilderNode ignores unowned references ──
  it("TEST 6: PromptBuilderNode: unowned references are discarded and not injected into prompt", async () => {
    const nodeInputs = {
      prompt: "Portrait of <character:char-user-A>",
      references: [{ id: "char-user-A" }],
    };
    const ctx = {
      nodeId: "test-builder",
      runId: "run-t2c-1",
      userId: "user-B",
    };

    const output = await executePromptBuilder(nodeInputs, ctx);
    // User A's character should NOT be resolved for User B
    assert.strictEqual(output.context.entities.characters.length, 0, "Characters list must be empty because User B does not own char-user-A");
    assert.strictEqual(output.context.references.length, 0, "No image URLs should be extracted from unowned entity");
    assert.ok(!output.finalPrompt.includes("Alice Secret"), "Final prompt must not leak User A's character name");
    assert.strictEqual(output.finalPrompt.trim(), "Portrait of");
  });

  // ── TEST 7: Legitimate owner (User A) operations succeed ──
  it("TEST 7: Legitimate Owner: User A referencing own character and media succeeds", async () => {
    // 7a. Resolver succeeds for owner
    const charResolved = await resolveWorkflowReference("char-user-A", "user-A");
    assert.ok(charResolved, "User A should resolve own character");
    assert.strictEqual(charResolved.name, "Alice Secret");

    const mediaUrlResolved = await resolvePrimaryMediaUrl("wf-user-A", "user-A");
    assert.ok(mediaUrlResolved, "User A should resolve own primary media URL");

    // 7b. Image Gen HTTP request succeeds for owner
    const res = await fetch(`${baseUrl}/api/images/generated`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": testSecret,
        "x-user-id": "user-A",
      },
      body: JSON.stringify({
        prompt: "A photo of Alice",
        model: "seedream_v5",
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
});
