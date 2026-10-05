import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import charactersRouter from "../../routes/characters.js";
import elementRoutes from "../../routes/elementRoutes.js";
import { db, characterService, elementService } from "../../src/container.js";

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
  const testSecret = "test-internal-secret-phase0";
  const originalSecret = process.env.INTERNAL_SECRET;

  // Stored state for test database doubles
  let mockCharacters;
  let mockElements;
  let mockWorkflows;
  let mockProjects;

  let originalDbCharacters;
  let originalDbElements;
  let originalDbWorkflows;
  let originalDbProjects;

  before(async () => {
    process.env.INTERNAL_SECRET = testSecret;

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
    process.env.INTERNAL_SECRET = originalSecret;
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
    setTimeout(() => process.exit(0), 100);
  });

  beforeEach(() => {
    mockProjects = [
      { id: "proj-user-A", user_id: "user-A" },
      { id: "proj-user-B", user_id: "user-B" },
    ];

    mockWorkflows = [
      { id: "char-A-wf", project_id: "proj-user-A", display_name: "Hero A" },
      { id: "elem-A-wf", project_id: "proj-user-A", display_name: "Sword A" },
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
        name: "Sword A",
        description: "User A's magical sword",
        element_type: "object",
      },
    ];

    // Back up original repo methods
    originalDbProjects = { ...db.projects };
    originalDbCharacters = { ...db.characters };
    originalDbElements = { ...db.elements };
    originalDbWorkflows = { ...db.workflows };

    // Set up mock repository doubles
    db.projects.findByUser = async (userId, projectId = null) => {
      return mockProjects.filter((p) => p.user_id === userId && (!projectId || p.id === projectId));
    };
    db.projects.findById = async (id) => mockProjects.find((p) => p.id === id) || null;

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

    // Stub workflowService delete on characterService if present
    if (characterService.workflowService) {
      characterService.workflowService.deleteWorkflow = async () => true;
    }
    if (characterService.generationService) {
      characterService.generationService.enqueueSheetGeneration = async () => ({
        success: true,
        workflowId: "mock-sheet-wf",
      });
    }
  });

  afterEach(() => {
    Object.assign(db.projects, originalDbProjects);
    Object.assign(db.characters, originalDbCharacters);
    Object.assign(db.elements, originalDbElements);
    Object.assign(db.workflows, originalDbWorkflows);
  });

  // ── CHARACTER TESTS ─────────────────────────────────────────────────────────

  it("TEST 1: Character Sheet: User B on User A's character returns 404 and prevents sheet generation", async () => {
    const res = await fetch(`${baseUrl}/api/characters/char-user-A/generate-sheet`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": testSecret,
        "x-user-id": "user-B",
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
        "x-internal-secret": testSecret,
        "x-user-id": "user-B",
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
        "x-internal-secret": testSecret,
        "x-user-id": "user-B",
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
        "x-internal-secret": testSecret,
        "x-user-id": "user-B",
      },
    });

    assert.strictEqual(res.status, 404, `Expected HTTP 404 for unowned element read but got ${res.status}`);
  });

  it("TEST 5: Element Update: User B on User A's element returns 404 and prevents mutation", async () => {
    const res = await fetch(`${baseUrl}/api/v2/elements/elem-user-A`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": testSecret,
        "x-user-id": "user-B",
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
        "x-internal-secret": testSecret,
        "x-user-id": "user-B",
      },
    });

    assert.strictEqual(res.status, 404, `Expected HTTP 404 for unowned element delete but got ${res.status}`);
    assert.strictEqual(mockElements.length, 1, "Element must not be deleted");
  });

  it("TEST 7: Element List: User B on User A's project returns 404", async () => {
    const res = await fetch(`${baseUrl}/api/v2/elements/project/proj-user-A`, {
      method: "GET",
      headers: {
        "x-internal-secret": testSecret,
        "x-user-id": "user-B",
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
        "x-internal-secret": testSecret,
        "x-user-id": "user-A",
      },
      body: JSON.stringify({ name: "Hero A Updated" }),
    });
    assert.strictEqual(updateRes.status, 200);
    assert.strictEqual(mockCharacters[0].name, "Hero A Updated");

    // 2. Owner reads element
    const elemRes = await fetch(`${baseUrl}/api/v2/elements/elem-user-A`, {
      method: "GET",
      headers: {
        "x-internal-secret": testSecret,
        "x-user-id": "user-A",
      },
    });
    assert.strictEqual(elemRes.status, 200);
  });
});
