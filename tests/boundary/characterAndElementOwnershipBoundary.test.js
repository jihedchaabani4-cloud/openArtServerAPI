import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import charactersRouter from "../../routes/characters.js";
import elementRoutes from "../../routes/elementRoutes.js";
import { db, characterService, elementService } from "../../src/container.js";
import { rateLimitRedisConnection, redisConnection, workerRedisConnection } from "../../src/queue/redis.js";
import { supabase } from "../../lib/supabase.js";

// @covers POST /api/characters/:characterId/generate-sheet
// @covers PATCH /api/characters/:characterId
// @covers DELETE /api/characters/:characterId
// @covers GET /api/v2/elements/:id
// @covers PATCH /api/v2/elements/:id
// @covers DELETE /api/v2/elements/:id
// @covers GET /api/v2/elements/project/:projectId

describe("Character and Element Ownership Security & Boundary Tests (Task T2b)", () => {
  let server;
  let baseUrl;
  let origGetUser;

  // Stored state for test database doubles
  let mockCharacters;
  let mockElements;
  let mockWorkflows;
  let mockProjects;
  let mockMedia;

  let originalDbCharacters;
  let originalDbElements;
  let originalDbWorkflows;
  let originalDbProjects;
  let originalDbMedia;

  let workflowCreationCalls = [];
  let characterUpsertCalls = [];
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
    app.use("/api/characters", charactersRouter);
    app.use("/api/v2/elements", elementRoutes);
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
    workflowCreationCalls = [];
    characterUpsertCalls = [];
    mediaCreationCalls = [];
    enqueueCalls = [];

    mockProjects = [
      { id: "proj-user-A", user_id: "user-A" },
      { id: "proj-user-B", user_id: "user-B" },
    ];

    mockWorkflows = [
      { id: "char-A-wf", project_id: "proj-user-A", user_id: "user-A", display_name: "Hero A" },
      { id: "elem-A-wf", project_id: "proj-user-A", user_id: "user-A", display_name: "Sword A" },
      { id: "elem-B-wf", project_id: "proj-user-B", user_id: "user-B", display_name: "Shield B" },
    ];

    mockCharacters = [
      {
        id: "char-user-A",
        workflow_id: "char-A-wf",
        project_id: "proj-user-A",
        user_id: "user-A",
        name: "Hero A",
        description: "User A's character",
      },
    ];

    mockElements = [
      {
        id: "elem-user-A",
        workflow_id: "elem-A-wf",
        project_id: "proj-user-A",
        user_id: "user-A",
        name: "Sword A",
        description: "User A's magical sword",
        element_type: "object",
      },
      {
        id: "elem-user-B",
        workflow_id: "elem-B-wf",
        project_id: "proj-user-B",
        user_id: "user-B",
        name: "Shield B",
        description: "User B's shield",
        element_type: "object",
      },
    ];

    mockMedia = [
      {
        id: "media-user-A",
        workflow_id: "char-A-wf",
        project_id: "proj-user-A",
        user_id: "user-A",
        url: "https://cdn.example.com/user-a-media.png",
      },
      {
        id: "media-user-B",
        workflow_id: "elem-B-wf",
        project_id: "proj-user-B",
        user_id: "user-B",
        url: "https://cdn.example.com/user-b-media.png",
      },
    ];

    // Back up original repo methods
    originalDbProjects = { ...db.projects };
    originalDbCharacters = { ...db.characters };
    originalDbElements = { ...db.elements };
    originalDbWorkflows = { ...db.workflows };
    originalDbMedia = { ...db.media };

    // Set up mock repository doubles
    db.projects.findByUser = async (userId, projectId = null) => {
      return mockProjects.filter((p) => p.user_id === userId && (!projectId || p.id === projectId));
    };
    db.projects.findById = async (id) => mockProjects.find((p) => p.id === id) || null;

    db.workflows.createWorkflow = async (data) => {
      workflowCreationCalls.push(data);
      const wf = { ...data, create_time: new Date().toISOString() };
      mockWorkflows.push(wf);
      return wf;
    };
    db.workflows.findById = async (id) => mockWorkflows.find((w) => w.id === id) || null;
    db.workflows.getWorkflow = async (id) => mockWorkflows.find((w) => w.id === id) || null;
    db.workflows.updateFields = async (id, fields) => {
      const wf = mockWorkflows.find((w) => w.id === id);
      if (wf) Object.assign(wf, fields);
      return wf || null;
    };
    db.workflows.deleteById = async (id) => {
      const idx = mockWorkflows.findIndex((w) => w.id === id);
      if (idx !== -1) mockWorkflows.splice(idx, 1);
      return true;
    };

    db.characters.upsert = async (data) => {
      characterUpsertCalls.push(data);
      const char = { ...data };
      mockCharacters.push(char);
      return char;
    };
    db.characters.findByCharacterId = async (id) =>
      mockCharacters.find((c) => c.id === id || c.workflow_id === id) || null;
    db.characters.updateCharacterFields = async (id, fields) => {
      const char = mockCharacters.find((c) => c.id === id || c.workflow_id === id);
      if (char) Object.assign(char, fields);
      return char || null;
    };
    db.characters.deleteById = async (id) => {
      const idx = mockCharacters.findIndex((c) => c.id === id);
      if (idx !== -1) mockCharacters.splice(idx, 1);
      return true;
    };

    db.elements.resolveRecord = async (id) =>
      mockElements.find((e) => e.id === id || e.workflow_id === id) || null;
    db.elements.findById = async (id) => mockElements.find((e) => e.id === id) || null;
    db.elements.update = async (id, fields) => {
      const el = mockElements.find((e) => e.id === id);
      if (el) Object.assign(el, fields);
      return el || null;
    };
    db.elements.deleteById = async (id) => {
      const idx = mockElements.findIndex((e) => e.id === id);
      if (idx !== -1) mockElements.splice(idx, 1);
      return true;
    };
    db.elements.list = async ({ projectId }) => {
      const wfs = mockWorkflows.filter((w) => w.project_id === projectId).map((w) => w.id);
      return mockElements.filter((e) => wfs.includes(e.workflow_id));
    };

    if (db.media) {
      db.media.createMedia = async (data) => {
        mediaCreationCalls.push(data);
        return { id: "mock-media-id", ...data };
      };
      db.media.findByWorkflow = async (wfId) => mockMedia.filter((m) => m.workflow_id === wfId);
      db.media.findById = async (id) => mockMedia.find((m) => m.id === id) || null;
      db.media.findMediaByIdOrWorkflow = async (id) => mockMedia.find((m) => m.id === id || m.workflow_id === id) || null;
    }

    // Stub workflowService delete on characterService if present
    if (characterService.workflowService) {
      characterService.workflowService.deleteWorkflow = async () => true;
    }
    if (characterService.generationService) {
      characterService.generationService.enqueueSheetGeneration = async (params) => {
        enqueueCalls.push(params);
        return {
          taskId: "mock-task-id",
          status: "processing",
          needsCredits: false,
          message: "Initiated",
          placeholderMedia: { id: "media-placeholder-id", status: "processing" },
        };
      };
    }
  });

  afterEach(() => {
    Object.assign(db.projects, originalDbProjects);
    Object.assign(db.characters, originalDbCharacters);
    Object.assign(db.elements, originalDbElements);
    Object.assign(db.workflows, originalDbWorkflows);
    if (originalDbMedia) Object.assign(db.media, originalDbMedia);
  });

  // ── CHARACTER TESTS ─────────────────────────────────────────────────────────

  it("TEST 1: Character Sheet: User B on User A's character returns 404 and prevents sheet generation", async () => {
    const res = await fetch(`${baseUrl}/api/characters/char-user-A/generate-sheet`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-B",
      },
      body: JSON.stringify({ prompt: "Malicious modification" }),
    });

    assert.strictEqual(res.status, 404, `Expected HTTP 404 for unowned character but got ${res.status}`);
    const body = await res.json();
    assert.strictEqual(body.ok, false);
    assert.match(body.message, /not found/i);
    assert.strictEqual(mockCharacters[0].description, "User A's character", "Character must not be mutated");
  });

  it("TEST 2: Character Update: User B on User A's character returns 404 and prevents mutation", async () => {
    const res = await fetch(`${baseUrl}/api/characters/char-user-A`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-B",
      },
      body: JSON.stringify({ name: "Hacked Name", description: "Hacked description" }),
    });

    assert.strictEqual(res.status, 404, `Expected HTTP 404 for unowned character update but got ${res.status}`);
    assert.strictEqual(mockCharacters[0].name, "Hero A", "Character name must not be changed");
    assert.strictEqual(mockCharacters[0].description, "User A's character", "Character desc must not be changed");
  });

  it("TEST 3: Character Delete: User B on User A's character returns 404 and prevents deletion", async () => {
    const res = await fetch(`${baseUrl}/api/characters/char-user-A`, {
      method: "DELETE",
      headers: {
        "Authorization": "Bearer token-user-B",
      },
    });

    assert.strictEqual(res.status, 404, `Expected HTTP 404 for unowned character delete but got ${res.status}`);
    assert.strictEqual(mockCharacters.length, 1, "Character must not be deleted");
  });

  // ── ELEMENT TESTS ───────────────────────────────────────────────────────────

  it("TEST 4: Element Read: User B on User A's element returns 404", async () => {
    const res = await fetch(`${baseUrl}/api/v2/elements/elem-user-A`, {
      method: "GET",
      headers: {
        "Authorization": "Bearer token-user-B",
      },
    });

    assert.strictEqual(res.status, 404, `Expected HTTP 404 for unowned element read but got ${res.status}`);
  });

  it("TEST 5: Element Update: User B on User A's element returns 404 and prevents mutation", async () => {
    const res = await fetch(`${baseUrl}/api/v2/elements/elem-user-A`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-B",
      },
      body: JSON.stringify({ name: "Hacked Sword", description: "Stolen sword" }),
    });

    assert.strictEqual(res.status, 404, `Expected HTTP 404 for unowned element update but got ${res.status}`);
    assert.strictEqual(mockElements[0].name, "Sword A", "Element name must not be mutated");
    assert.strictEqual(mockElements[0].description, "User A's magical sword", "Element desc must not be mutated");
  });

  it("TEST 6: Element Delete: User B on User A's element returns 404 and prevents deletion", async () => {
    const res = await fetch(`${baseUrl}/api/v2/elements/elem-user-A`, {
      method: "DELETE",
      headers: {
        "Authorization": "Bearer token-user-B",
      },
    });

    assert.strictEqual(res.status, 404, `Expected HTTP 404 for unowned element delete but got ${res.status}`);
    assert.strictEqual(mockElements.some((e) => e.id === "elem-user-A"), true, "Element must not be deleted");
  });

  it("TEST 7: Element List: User B on User A's project returns 404", async () => {
    const res = await fetch(`${baseUrl}/api/v2/elements/project/proj-user-A`, {
      method: "GET",
      headers: {
        "Authorization": "Bearer token-user-B",
      },
    });

    assert.strictEqual(res.status, 404, `Expected HTTP 404 for unowned project element list but got ${res.status}`);
  });

  // ── LEGITIMATE OWNER TESTS ──────────────────────────────────────────────────

  it("TEST 8: Character & Element: Legitimate owner User A operations succeed", async () => {
    // 1. Owner updates character
    const updateRes = await fetch(`${baseUrl}/api/characters/char-user-A`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-A",
      },
      body: JSON.stringify({ name: "Hero A Updated" }),
    });
    assert.strictEqual(updateRes.status, 200);
    assert.strictEqual(mockCharacters[0].name, "Hero A Updated");

    // 2. Owner reads element
    const elemRes = await fetch(`${baseUrl}/api/v2/elements/elem-user-A`, {
      method: "GET",
      headers: {
        "Authorization": "Bearer token-user-A",
      },
    });
    assert.strictEqual(elemRes.status, 200);
  });

  // ── NEW CHARACTER BOUNDARY OWNERSHIP TESTS (OWN-CHAR-1) ──────────────────────

  it("TEST 9 (OWN-CHAR-1): Character Create: User B using User A's character in references returns 404 and creates 0 records", async () => {
    workflowCreationCalls = [];
    characterUpsertCalls = [];
    enqueueCalls = [];

    const res = await fetch(`${baseUrl}/api/characters/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-B",
      },
      body: JSON.stringify({
        project_id: "proj-user-B",
        name: "Malicious Hero",
        prompt: "Stealing User A's character",
        references: ["char-user-A"],
      }),
    });

    assert.strictEqual(res.status, 404, `Expected HTTP 404 for unowned reference character but got ${res.status}`);
    const body = await res.json();
    assert.strictEqual(body.ok, false);
    assert.strictEqual(workflowCreationCalls.length, 0, "No workflow container must be created on foreign reference");
    assert.strictEqual(characterUpsertCalls.length, 0, "No character record must be created on foreign reference");
    assert.strictEqual(enqueueCalls.length, 0, "No generation job must be enqueued on foreign reference");
  });

  it("TEST 10 (OWN-CHAR-1): Character Create: User B using User A's media or element in references returns 404", async () => {
    workflowCreationCalls = [];
    characterUpsertCalls = [];
    enqueueCalls = [];

    // Reference User A's element
    const resElem = await fetch(`${baseUrl}/api/characters/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-B",
      },
      body: JSON.stringify({
        project_id: "proj-user-B",
        name: "Malicious Hero 2",
        references: ["elem-user-A"],
      }),
    });

    assert.strictEqual(resElem.status, 404, `Expected HTTP 404 for unowned reference element but got ${resElem.status}`);
    assert.strictEqual(workflowCreationCalls.length, 0, "No workflow created");
    assert.strictEqual(characterUpsertCalls.length, 0, "No character created");

    // Reference User A's media (sent as string instead of array)
    const resMedia = await fetch(`${baseUrl}/api/characters/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-B",
      },
      body: JSON.stringify({
        project_id: "proj-user-B",
        name: "Malicious Hero 3",
        references: "media-user-A",
      }),
    });

    assert.strictEqual(resMedia.status, 404, `Expected HTTP 404 for unowned reference media string but got ${resMedia.status}`);
    assert.strictEqual(workflowCreationCalls.length, 0, "No workflow created");
  });

  it("TEST 11 (OWN-CHAR-1): Character Create: User B using User A's projectId returns 404", async () => {
    workflowCreationCalls = [];
    characterUpsertCalls = [];
    enqueueCalls = [];

    const res = await fetch(`${baseUrl}/api/characters/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-B",
      },
      body: JSON.stringify({
        project_id: "proj-user-A",
        name: "Hijack Project",
        prompt: "Hijacking User A's project",
      }),
    });

    assert.strictEqual(res.status, 404, `Expected HTTP 404 for foreign project but got ${res.status}`);
    assert.strictEqual(workflowCreationCalls.length, 0);
    assert.strictEqual(characterUpsertCalls.length, 0);
  });

  it("TEST 12 (OWN-CHAR-1): Character Sheet Regen: Legitimate owner User A regenerating with foreign reference returns 404", async () => {
    enqueueCalls = [];

    const res = await fetch(`${baseUrl}/api/characters/char-user-A/generate-sheet`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-A",
      },
      body: JSON.stringify({
        references: ["elem-user-B"],
      }),
    });

    assert.strictEqual(res.status, 404, `Expected HTTP 404 when regenerating sheet with foreign reference but got ${res.status}`);
    assert.strictEqual(enqueueCalls.length, 0, "No sheet generation job must be enqueued with unowned references");
  });

  it("TEST 13 (OWN-CHAR-1): Legitimate Owner: User A creating character with owned references succeeds and normalizes string to array", async () => {
    workflowCreationCalls = [];
    characterUpsertCalls = [];
    enqueueCalls = [];

    // Create with string reference "char-user-A"
    const res = await fetch(`${baseUrl}/api/characters/create`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer token-user-A",
      },
      body: JSON.stringify({
        project_id: "proj-user-A",
        name: "Legit Hero A",
        prompt: "A legitimate character",
        references: "char-user-A",
      }),
    });

    assert.strictEqual(res.status, 200, `Expected HTTP 200 for legitimate owner but got ${res.status}`);
    const body = await res.json();
    assert.strictEqual(body.ok, true);
    assert.strictEqual(workflowCreationCalls.length, 1);
    assert.strictEqual(characterUpsertCalls.length, 1);
    assert.strictEqual(enqueueCalls.length, 1);
    assert.deepStrictEqual(enqueueCalls[0].references, ["char-user-A"], "String reference must be normalized to array");
  });
});
