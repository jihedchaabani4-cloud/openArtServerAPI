import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MediaRepository, inferWorkflowMediaRole, WORKFLOW_MEDIA_ROLES, WorkflowMediaRepository } from "#media/tools";
import { supabase } from "#shared/db/supabase.js";
import { WorkflowRepository, GenerationService } from "#generation/tools";
import { WorkflowMediaService } from "../../../src/systems/generation/internal/services/WorkflowMediaService.js";
import { ProjectReadService } from "#workspace/tools";
import { CharacterMediaService } from "#characters/tools";
import { ElementMediaService, elementRepository, ElementService } from "#elements/tools";
import { db } from "../../../src/container.js";
import { CrudServiceError } from "#shared";
import { assertOwns, setDb } from "#identity/tools";

// ─── Source: workflowMediaCompatibilityReads.test.js ───
{
function makeQuery(result, onCall = () => {}) {
  const query = {
    select(cols) { onCall("select", cols); return query; },
    eq(col, val) { onCall("eq", col, val); return query; },
    in(col, vals) { onCall("in", col, vals); return query; },
    or(expr) { onCall("or", expr); return query; },
    not(col, op, val) { onCall("not", col, op, val); return query; },
    order(col, opts) { onCall("order", col, opts); return query; },
    limit(n) { onCall("limit", n); return query; },
    single() { return Promise.resolve(result); },
    maybeSingle() { return Promise.resolve(result); },
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
  };
  return query;
}

describe("B3: workflow_media junction readers, tenant isolation & candidate library payload", () => {
  it("MediaRepository.findByWorkflow queries workflow_media exclusively and preserves response fields", async () => {
    const repo = new MediaRepository();
    repo.client = () => ({
      from(table) {
        if (table === "workflow_media") {
          return makeQuery({
            data: [
              {
                workflow_id: "wf-1",
                role: "sheet",
                created_at: "2026-01-01T00:00:00Z",
                media: {
                  id: "media-1",
                  step_id: "element_sheet",
                  url: "https://example.com/sheet.png",
                },
              },
            ],
            error: null,
          });
        }
        throw new Error(`unexpected table ${table}`);
      },
    });

    const rows = await repo.findByWorkflow("wf-1");

    assert.deepEqual(rows, [
      {
        id: "media-1",
        workflow_id: "wf-1",
        step_id: "element_sheet",
        url: "https://example.com/sheet.png",
        workflowId: "wf-1",
        role: "sheet",
        mediaRole: "sheet",
        workflow_media_created_at: "2026-01-01T00:00:00Z",
      },
    ]);
  });

  it("MediaRepository.findByWorkflow returns empty array when workflow_media has no rows and does NOT fall back to media.workflow_id", async () => {
    const calls = [];
    const repo = new MediaRepository();
    repo.client = () => ({
      from(table) {
        calls.push(table);
        if (table === "workflow_media") {
          return makeQuery({ data: [], error: null });
        }
        throw new Error(`unexpected fallback to table ${table}`);
      },
    });

    const rows = await repo.findByWorkflow("wf-empty");

    assert.deepEqual(calls, ["workflow_media"]);
    assert.deepEqual(rows, []);
  });

  it("WorkflowRepository.getPrimaryMedia queries workflow_media with is_primary = true ONLY (no media.workflow_id fallback)", async () => {
    const calls = [];
    const repo = new WorkflowRepository();
    repo.client = () => ({
      from(table) {
        calls.push(table);
        if (table === "workflow_media") {
          return makeQuery({ data: null, error: null });
        }
        throw new Error(`unexpected fallback to table ${table}`);
      },
    });

    const media = await repo.getPrimaryMedia("wf-unpinned");

    assert.equal(media, null);
    assert.deepEqual(calls, ["workflow_media"]);
  });

  it("MediaRepository.findLatestByWorkflow and findMediaByIdOrWorkflow query workflow_media without media.workflow_id", async () => {
    const ops = [];
    const repo = new MediaRepository();
    repo.client = () => ({
      from(table) {
        if (table === "media") {
          return makeQuery(
            { data: null, error: null },
            (op, a, b) => ops.push({ table, op, a, b })
          );
        }
        if (table === "workflow_media") {
          return makeQuery(
            {
              data: [
                {
                  workflow_id: "wf-latest-1",
                  role: "output",
                  created_at: "2026-01-02T00:00:00Z",
                  workflow: { workflow_type: "IMAGE" },
                  media: {
                    id: "m-latest-1",
                    url: "https://example.com/latest.png",
                    config: null,
                  },
                },
              ],
              error: null,
            },
            (op, a, b) => ops.push({ table, op, a, b })
          );
        }
        throw new Error(`unexpected table ${table}`);
      },
    });

    const latest = await repo.findMediaByIdOrWorkflow("wf-latest-1");
    assert.equal(latest?.id, "m-latest-1");
    assert.equal(latest?.workflow_id, "wf-latest-1");
    assert.equal(
      ops.some((o) => o.table === "media" && (o.a === "workflow_id" || String(o.a).includes("workflow_id"))),
      false,
      "Must never filter media by workflow_id"
    );
  });

  it("ProjectReadService.getWorkflowByMedia resolves workflowId via workflow_media without reading media.workflow_id", async () => {
    let queriedWorkflowId = null;
    const mockDb = {
      workflowMedia: {
        findByMedia: async (mediaId) =>
          mediaId === "m-proj-1" ? [{ workflow_id: "wf-from-junction", media_id: "m-proj-1", role: "output" }] : [],
      },
      workflows: {
        getWorkflow: async (wfId) => {
          queriedWorkflowId = wfId;
          return { id: wfId, project_id: "proj-1" };
        },
      },
      media: {
        findByWorkflow: async (wfId) => [{ id: "m-proj-1", workflow_id: wfId, role: "output", url: "https://example.com/1.png", status: "completed" }],
      },
    };

    const service = new ProjectReadService({ db: mockDb });
    service._verifyMediaOwnership = async () => true;

    // Even if media row has NO workflow_id property, getWorkflowByMedia must resolve workflowId from workflow_media
    const result = await service.getWorkflowByMedia({
      mediaId: "m-proj-1",
      userId: "user-1",
    });

    assert.equal(queriedWorkflowId, "wf-from-junction");
    assert.equal(result.workflow.id, "wf-from-junction");
    assert.equal(result.items.length, 1);
  });

  it("GenerationService.#buildLibraryPayload caps candidates at 8 (created_at ASC) while ALWAYS preserving pinned primary_media_id and sheet role", async () => {
    // 12 candidate media rows for wf-many; sheet is at #10, pinned primary_media_id is at #11
    const allCandidates = Array.from({ length: 12 }, (_, idx) => {
      const n = idx + 1;
      const padded = String(n).padStart(2, "0");
      return {
        id: `m-${n}`,
        workflow_id: "wf-many",
        workflowId: "wf-many",
        role: n === 10 ? "sheet" : "output",
        mediaRole: n === 10 ? "sheet" : "output",
        is_primary: n === 11,
        isPrimary: n === 11,
        step_id: n === 10 ? "character_sheet" : "image_generation",
        generation_config_id: "cfg-1",
        url: `https://cdn.example.com/img-${n}.png`,
        width: 1024,
        height: 1024,
        status: "completed",
        create_time: `2026-01-${padded}T00:00:00.000Z`,
        workflow_media_created_at: `2026-01-${padded}T00:00:00.000Z`,
      };
    });

    const mockDb = {
      projects: {
        findByUser: async () => [{ id: "proj-1" }],
      },
      workflows: {
        findByProjectsPaginated: async () => ({
          workflows: [
            {
              id: "wf-many",
              project_id: "proj-1",
              session_id: "sess-1",
              display_name: "Hero Character",
              primary_media_id: "m-11",
              favorited: false,
              workflow_type: "CHARACTER",
              create_time: "2026-01-01T00:00:00.000Z",
            },
            {
              id: "wf-unpinned",
              project_id: "proj-1",
              session_id: "sess-1",
              display_name: "Unpinned Generation",
              primary_media_id: null,
              favorited: false,
              workflow_type: "IMAGE",
              create_time: "2026-01-02T00:00:00.000Z",
            },
          ],
          total: 2,
        }),
      },
      workflowMedia: {
        findByWorkflowIds: async () => [
          ...allCandidates,
          {
            id: "m-unpinned-1",
            workflow_id: "wf-unpinned",
            workflowId: "wf-unpinned",
            role: "output",
            mediaRole: "output",
            step_id: "image_generation",
            generation_config_id: "cfg-1",
            url: "https://cdn.example.com/unpinned-1.png",
            width: 1024,
            height: 1024,
            status: "completed",
            create_time: "2026-01-02T00:00:00.000Z",
            workflow_media_created_at: "2026-01-02T00:00:00.000Z",
          },
        ],
      },
      media: {
        findByIds: async (ids) =>
          allCandidates
            .filter((m) => ids.includes(m.id))
            // Intentionally strip workflow_id from media row to prove GenerationService uses workflow.id
            .map(({ workflow_id: _w, workflowId: _wid, ...rest }) => rest),
      },
      configs: {
        findByIdsWithReferences: async () => [
          {
            id: "cfg-1",
            prompt: "cinematic hero portrait",
            model: "nanobana_2",
            aspect_ratio: "1:1",
            generation_type: "TEXT_ONLY",
            seed: 42,
            visibility: "PRIVATE",
            references: [],
          },
        ],
      },
    };

    const service = new GenerationService({ db: mockDb });
    const library = await service.getUserLibrary("user-1", { projectId: "proj-1", limit: 30, offset: 0 });

    assert.equal(library.data.length, 2);
    const entryMany = library.data[0];
    assert.ok(Array.isArray(entryMany.candidates), "Library entry must include candidates array");
    assert.equal(entryMany.candidates.length, 8, "Candidates must be capped at 8 items");

    const candidateIds = entryMany.candidates.map((c) => c.id);
    // Must preserve m-10 (sheet) and m-11 (pinned primary_media_id) plus first 6 items in created_at ASC order
    assert.deepEqual(candidateIds, ["m-1", "m-2", "m-3", "m-4", "m-5", "m-6", "m-10", "m-11"]);
    assert.equal(entryMany.primary_media?.id, "m-11");
    assert.equal(entryMany.primary_media?.workflow_id, "wf-many");

    // Unpinned workflow has primary_media: null and 1 candidate in candidates
    const entryUnpinned = library.data[1];
    assert.equal(entryUnpinned.primary_media, null);
    assert.equal(entryUnpinned.candidates.length, 1);
    assert.equal(entryUnpinned.candidates[0].id, "m-unpinned-1");
  });

  it("WorkflowMediaService.resolveOwnedSourceMedia rejects unlinked media (0 workflow_media links) with 404", async () => {
    const mockDb = {
      media: {
        findById: async (id) => ({
          id,
          project_id: "proj-1",
          url: "https://cdn.example.com/orphan.png",
          status: "completed",
        }),
      },
      workflowMedia: {
        findByMedia: async () => [], // 0 links in workflow_media
      },
      workflows: {
        getWorkflow: async () => null,
      },
    };

    const workflowMediaService = new WorkflowMediaService({
      db: mockDb,
      storageService: {},
      mediaUploadService: { discard: async () => ({}) },
      authService: { verifyMediaOwnership: async () => true, verifyWorkflowOwnership: async () => true },
    });

    await assert.rejects(
      () => workflowMediaService.resolveOwnedSourceMedia({ mediaId: "m-orphan-1", userId: "user-1", projectId: "proj-1" }),
      (err) => err.statusCode === 404
    );
  });

  it("measures payload size on a representative 30-workflow page (primary_media only vs 8-capped candidates vs 20 uncapped)", async () => {
    // Representative 30-workflow page: 10 workflows with 1 media, 15 workflows with 4 media, 5 workflows with 16 media
    const workflows = Array.from({ length: 30 }, (_, idx) => {
      const wfNum = idx + 1;
      return {
        id: `wf-page-${wfNum}`,
        project_id: "proj-bench-1",
        session_id: "sess-bench-1",
        display_name: `Workflow Asset #${wfNum}`,
        primary_media_id: `m-wf-${wfNum}-1`,
        favorited: wfNum % 5 === 0,
        workflow_type: wfNum <= 5 ? "CHARACTER" : "IMAGE",
        create_time: "2026-01-15T12:00:00.000Z",
      };
    });

    const relationRows = [];
    for (let i = 0; i < workflows.length; i++) {
      const wf = workflows[i];
      const count = i < 5 ? 16 : (i < 20 ? 4 : 1);
      for (let j = 1; j <= count; j++) {
        relationRows.push({
          id: `m-wf-${i + 1}-${j}`,
          workflow_id: wf.id,
          workflowId: wf.id,
          role: j === 1 && wf.workflow_type === "CHARACTER" ? "sheet" : "output",
          mediaRole: j === 1 && wf.workflow_type === "CHARACTER" ? "sheet" : "output",
          step_id: j === 1 && wf.workflow_type === "CHARACTER" ? "character_sheet" : "image_generation",
          generation_config_id: "cfg-bench-1",
          url: `https://cdn.example.com/projects/proj-bench-1/${wf.id}/media-${j}.png`,
          width: 1024,
          height: 1024,
          status: "completed",
          create_time: `2026-01-15T12:${String(j).padStart(2, "0")}:00.000Z`,
          workflow_media_created_at: `2026-01-15T12:${String(j).padStart(2, "0")}:00.000Z`,
        });
      }
    }

    const mockDb = {
      projects: {
        findByUser: async () => [{ id: "proj-bench-1" }],
      },
      workflows: {
        findByProjectsPaginated: async () => ({ workflows, total: 30 }),
      },
      workflowMedia: {
        findByWorkflowIds: async () => relationRows,
      },
      media: {
        findByIds: async (ids) => relationRows.filter((r) => ids.includes(r.id)),
      },
      configs: {
        findByIdsWithReferences: async () => [
          {
            id: "cfg-bench-1",
            prompt: "A detailed cinematic keyframe of a futuristic floating market at dusk",
            model: "nanobana_2",
            aspect_ratio: "16:9",
            generation_type: "TEXT_ONLY",
            seed: 123456,
            visibility: "PRIVATE",
            references: [],
          },
        ],
      },
    };

    const service = new GenerationService({ db: mockDb });
    const afterPayload = await service.getUserLibrary("user-bench", { projectId: "proj-bench-1", limit: 30, offset: 0 });
    const beforePrimaryOnlyPayload = {
      ...afterPayload,
      data: afterPayload.data.map(({ candidates: _c, ...rest }) => rest),
    };

    const beforeBytes = Buffer.byteLength(JSON.stringify(beforePrimaryOnlyPayload), "utf8");
    const afterBytes = Buffer.byteLength(JSON.stringify(afterPayload), "utf8");
    const uncappedPayload = {
      ...afterPayload,
      data: afterPayload.data.map((entry, idx) => ({
        ...entry,
        candidates: relationRows.filter((r) => r.workflow_id === workflows[idx].id),
      })),
    };
    const uncappedBytes = Buffer.byteLength(JSON.stringify(uncappedPayload), "utf8");

    assert.equal(afterPayload.data.length, 30);
    // Every workflow with 16 items was capped at 8
    for (let i = 0; i < 5; i++) {
      assert.equal(afterPayload.data[i].candidates.length, 8);
    }
    assert.ok(beforeBytes > 0 && afterBytes > beforeBytes);
    assert.ok(
      afterBytes < uncappedBytes,
      `Expected 8-capped payload (${afterBytes} B) < uncapped payload (${uncappedBytes} B); primary-only baseline: ${beforeBytes} B`
    );
  });
});
}

// ─── Source: workflowMediaRole.test.js ───
{
describe("workflow media role inference", () => {
  it("maps legacy generation and upload step ids to canonical roles", () => {
    assert.equal(inferWorkflowMediaRole({ stepId: "image_generation" }), "output");
    assert.equal(inferWorkflowMediaRole({ stepId: "video_generation" }), "output");
    assert.equal(inferWorkflowMediaRole({ stepId: "upload" }), "original");
    assert.equal(inferWorkflowMediaRole({ stepId: "CAE", workflowType: "UPLOAD" }), "original");
  });

  it("maps character and element step ids to canonical roles (element has detail only, no sheet)", () => {
    assert.equal(inferWorkflowMediaRole({ stepId: "character_sheet" }), "sheet");
    assert.equal(inferWorkflowMediaRole({ stepId: "character_detail" }), "detail");
    assert.equal(inferWorkflowMediaRole({ stepId: "element_sheet" }), "detail");
    assert.equal(inferWorkflowMediaRole({ stepId: "element_reference" }), "detail");
    assert.equal(inferWorkflowMediaRole({ stepId: "CAE", workflowType: "CHARACTER_SHEET" }), "sheet");
    assert.equal(inferWorkflowMediaRole({ stepId: "CAE", workflowType: "ELEMENT_SHEET" }), "detail");
    assert.equal(inferWorkflowMediaRole({ stepId: "anything", workflowType: "ELEMENT" }), "detail");
  });

  it("accepts explicit valid roles and falls back to output", () => {
    assert.equal(inferWorkflowMediaRole({ role: "detail", stepId: "image_generation" }), "detail");
    assert.equal(inferWorkflowMediaRole({ role: "not-a-role", stepId: "unknown" }), "output");
    assert.deepEqual(WORKFLOW_MEDIA_ROLES, ["output", "original", "sheet", "detail", "reference", "avatar", "turnaround"]);
  });
});
}

// ─── Source: workflowMediaRoleResolution.test.js ───
{
describe("workflow_media role-based domain resolution", () => {
  const originals = {};

  beforeEach(() => {
    originals.characters = db.characters;
    originals.media = db.media;
  });

  afterEach(() => {
    db.characters = originals.characters;
    db.media = originals.media;
  });

  it("CharacterMediaService.uploadSheetMedia reuses existing sheet rows identified by role", async () => {
    let updated = null;
    let created = false;
    const service = new CharacterMediaService({
      mediaUploadService: {
        upload: async ({ files }) => ({
          uploaded: [{ id: "existing-sheet", url: files[0], step_id: "image_generation" }],
        }),
        discard: async () => ({}),
      },
      workflowMediaService: {
        attachMediaItems: async ({ workflowId, role, items }) => {
          updated = { id: "existing-sheet", fields: { step_id: "image_generation" } };
          return {
            attached: [{
              media: { id: "existing-sheet", step_id: "image_generation", url: items[0]?.uploadedFile?.url },
              is_primary: true,
            }],
          };
        },
      },
      authService: { verifyWorkflowOwnership: async () => true },
      db: {
        workflows: {
          getWorkflow: async () => ({ id: "char-wf-1", project_id: "proj-1", user_id: "user-1" }),
          updatePrimaryMedia: async () => ({}),
        },
        media: {
          findByWorkflow: async () => [
            {
              id: "existing-sheet",
              workflow_id: "char-wf-1",
              step_id: "image_generation",
              mediaRole: "sheet",
              status: "success",
              url: "https://cdn.example.com/old.png",
            },
          ],
          updateFields: async (id, fields) => {
            updated = { id, fields };
            return { id, ...fields };
          },
          createMedia: async () => {
            created = true;
            return { id: "new-media" };
          },
          deleteByIdAndWorkflow: async () => ({}),
        },
        characters: {
          updateCharacterFields: async () => ({}),
        },
        workflowMedia: {
          linkMedia: async () => ({}),
        },
      },
      storageService: {},
      mediaIngestionService: {
        ingest: async () => ({
          url: "https://cdn.example.com/new.png",
          width: 1344,
          height: 768,
        }),
      },
    });

    await service.uploadSheetMedia({
      characterId: "char-wf-1",
      imageUrl: "https://source.example.com/new.png",
      userId: "user-1",
    });

    assert.equal(created, false);
    assert.equal(updated.id, "existing-sheet");
    assert.equal(updated.fields.step_id, "image_generation");
  });

  it("CharacterMediaService.removeDetailMedia accepts detail rows identified by role", async () => {
    let deleted = false;
    const service = new CharacterMediaService({
      mediaUploadService: { upload: async () => ({}) },
      workflowMediaService: { attachMediaItems: async () => ({}) },
      authService: { verifyWorkflowOwnership: async () => true },
      db: {
        workflows: {
          getWorkflow: async () => ({ id: "char-wf-1", user_id: "user-1" }),
        },
        media: {
          findById: async () => ({
            id: "detail-media",
            workflow_id: "char-wf-1",
            step_id: "image_generation",
            mediaRole: "detail",
            url: null,
          }),
          deleteById: async () => {
            deleted = true;
          },
        },
        workflowMedia: {
          findByMedia: async () => [{ workflow_id: "char-wf-1", media_id: "detail-media", role: "detail" }],
          unlinkAndReapOrphan: async () => {
            deleted = true;
            return { unlinked: true, is_orphan: true };
          },
          unlink: async () => {
            deleted = true;
          },
        },
      },
      storageService: {},
    });

    const result = await service.removeDetailMedia({
      characterId: "char-wf-1",
      mediaId: "detail-media",
      userId: "user-1",
    });

    assert.equal(result.ok, true);
    assert.equal(deleted, true);
  });
});
}

// ─── Source: workflowPrimaryMediaCanonicalContract.test.js ───
{
describe("Generic Workflow Primary Media — Centralize and Reuse Canonical Contract", () => {
    function createMockDb() {
        const workflows = [];
        const elements = [];
        const media = [];
        const workflowMedia = [];
        let writtenWorkflowPrimaryMediaId = false;

        return {
            workflows: {
                createWorkflow: async (payload) => {
                    const row = { id: `wf-${workflows.length + 1}`, ...payload };
                    workflows.push(row);
                    return row;
                },
                findById: async (id) => workflows.find((w) => w.id === id) || null,
                getPrimaryMediaUrl: async (workflowId) => {
                    const link = workflowMedia.find((wm) => wm.workflow_id === workflowId && wm.is_primary === true);
                    if (!link) return null;
                    const m = media.find((med) => med.id === link.media_id);
                    return m?.url || null;
                },
                updateFields: async (workflowId, fields) => {
                    if ("primary_media_id" in fields) {
                        writtenWorkflowPrimaryMediaId = true;
                    }
                    const wf = workflows.find((w) => w.id === workflowId);
                    if (wf) Object.assign(wf, fields);
                    return wf || { id: workflowId, ...fields };
                },
                wasPrimaryMediaIdColumnWritten: () => writtenWorkflowPrimaryMediaId,
            },
            elements: {
                create: async (payload) => {
                    const row = { id: `00000000-0000-0000-0000-00000000000${elements.length + 1}`, ...payload };
                    elements.push(row);
                    return row;
                },
                resolveRecord: async (id) => elements.find((e) => e.id === id || e.workflow_id === id) || null,
                findById: async (id) => elements.find((e) => e.id === id) || null,
                update: async (id, patch) => {
                    const el = elements.find((e) => e.id === id || e.workflow_id === id);
                    if (!el) return null;
                    Object.assign(el, patch);
                    return el;
                },
            },
            media: {
                createMedia: async (payload) => {
                    const row = { id: `media-${media.length + 1}`, status: "completed", url: "https://example.com/m.png", ...payload };
                    media.push(row);
                    return row;
                },
                findById: async (id) => media.find((m) => m.id === id) || null,
                findWithContext: async (id) => {
                    const m = media.find((item) => item.id === id);
                    if (!m) return null;
                    return { ...m, workflow: { session_id: "s-1" } };
                },
                findByWorkflow: async (workflowId) => {
                    const links = workflowMedia.filter((wm) => wm.workflow_id === workflowId);
                    return links.map((l) => {
                        const m = media.find((med) => med.id === l.media_id);
                        return { ...(m || {}), role: l.role, is_primary: l.is_primary };
                    });
                },
            },
            workflowMedia: {
                linkMedia: async ({ workflowId, mediaId, role, is_primary, isPrimary }) => {
                    const resolvedPrimary = Boolean(is_primary ?? isPrimary ?? false);
                    if (resolvedPrimary) {
                        for (const wm of workflowMedia) {
                            if (wm.workflow_id === workflowId) wm.is_primary = false;
                        }
                    }
                    const row = { workflow_id: workflowId, media_id: mediaId, role: role || "detail", is_primary: resolvedPrimary };
                    workflowMedia.push(row);
                    return row;
                },
                getPrimaryMedia: async (workflowId) => {
                    return workflowMedia.find((wm) => wm.workflow_id === workflowId && wm.is_primary === true) || null;
                },
                findByWorkflow: async (workflowId) => {
                    return workflowMedia.filter((wm) => wm.workflow_id === workflowId);
                },
                findByMedia: async (mediaId) => {
                    return workflowMedia.filter((wm) => wm.media_id === mediaId);
                },
                isMediaLinkedToWorkflow: async ({ workflowId, mediaId }) => {
                    return workflowMedia.some((wm) => wm.workflow_id === workflowId && wm.media_id === mediaId);
                },
                setPrimaryMedia: async ({ workflowId, mediaId }) => {
                    for (const wm of workflowMedia) {
                        if (wm.workflow_id === workflowId) {
                            wm.is_primary = (wm.media_id === mediaId);
                        }
                    }
                    return { workflow_id: workflowId, media_id: mediaId, is_primary: true };
                },
                clearPrimaryMedia: async ({ workflowId }) => {
                    for (const wm of workflowMedia) {
                        if (wm.workflow_id === workflowId) {
                            wm.is_primary = false;
                        }
                    }
                    return { workflow_id: workflowId, cleared: true };
                },
                setPrimaryMediaIfNone: async ({ workflowId, mediaId }) => {
                    const hasPrimary = workflowMedia.some((wm) => wm.workflow_id === workflowId && wm.is_primary === true);
                    if (hasPrimary) return false;
                    for (const wm of workflowMedia) {
                        if (wm.workflow_id === workflowId && wm.media_id === mediaId) {
                            wm.is_primary = true;
                            return true;
                        }
                    }
                    return false;
                },
                unlinkAndReapOrphan: async ({ workflowId, mediaId }) => {
                    const idx = workflowMedia.findIndex((wm) => wm.workflow_id === workflowId && wm.media_id === mediaId);
                    if (idx === -1) return { unlinked: false, is_orphan: false };
                    const [removed] = workflowMedia.splice(idx, 1);
                    const remaining = workflowMedia.filter((wm) => wm.media_id === mediaId).length;
                    return {
                        unlinked: true,
                        is_orphan: remaining === 0,
                        was_primary: Boolean(removed.is_primary),
                    };
                },
                unlink: async ({ workflowId, mediaId }) => {
                    const idx = workflowMedia.findIndex((wm) => wm.workflow_id === workflowId && wm.media_id === mediaId);
                    if (idx !== -1) workflowMedia.splice(idx, 1);
                    return { unlinked: idx !== -1 };
                },
            },
            _store: { workflows, elements, media, workflowMedia },
        };
    }

    function createMockAuthService(ownedWorkflows = new Set(), ownedMedia = new Set()) {
        return {
            verifyWorkflowOwnership: async (workflowId, userId) => {
                if (!userId) return true;
                return ownedWorkflows.has(`${userId}:${workflowId}`);
            },
            verifyMediaOwnership: async (mediaId, userId) => {
                if (!userId) return true;
                return ownedMedia.has(`${userId}:${mediaId}`);
            },
        };
    }

    it("1. WorkflowMediaService.setPrimaryMedia atomically switches primary and never writes to workflow.primary_media_id", async () => {
        const mockDb = createMockDb();
        const authService = createMockAuthService(new Set(["u1:wf-1"]), new Set(["u1:m1", "u1:m2"]));
        const service = new WorkflowMediaService({ db: mockDb, authService, mediaUploadService: { discard: async () => ({}) } });

        // Setup workflow and two linked media items
        mockDb._store.workflows.push({ id: "wf-1", user_id: "u1" });
        mockDb._store.media.push({ id: "m1", status: "completed", url: "https://example.com/1.png" });
        mockDb._store.media.push({ id: "m2", status: "completed", url: "https://example.com/2.png" });
        mockDb._store.workflowMedia.push({ workflow_id: "wf-1", media_id: "m1", is_primary: true, role: "detail" });
        mockDb._store.workflowMedia.push({ workflow_id: "wf-1", media_id: "m2", is_primary: false, role: "detail" });

        // Explicit primary switch to m2
        const result = await service.setPrimaryMedia({ workflowId: "wf-1", mediaId: "m2", userId: "u1" });

        assert.equal(result.is_primary, true);
        assert.equal(result.primaryMediaId, "m2");
        assert.equal(result.primary_media_id, "m2");

        const wm1 = mockDb._store.workflowMedia.find((wm) => wm.media_id === "m1");
        const wm2 = mockDb._store.workflowMedia.find((wm) => wm.media_id === "m2");
        assert.equal(wm1.is_primary, false, "Previous primary must be demoted");
        assert.equal(wm2.is_primary, true, "New primary must be promoted");

        // Verify no write to removed workflow.primary_media_id column
        assert.equal(mockDb.workflows.wasPrimaryMediaIdColumnWritten(), false, "Never write to workflow.primary_media_id");
    });

    it("2. WorkflowMediaService: mediaId: null explicitly clears primary media", async () => {
        const mockDb = createMockDb();
        const authService = createMockAuthService(new Set(["u1:wf-1"]), new Set());
        const service = new WorkflowMediaService({ db: mockDb, authService, mediaUploadService: { discard: async () => ({}) } });

        mockDb._store.workflows.push({ id: "wf-1", user_id: "u1" });
        mockDb._store.workflowMedia.push({ workflow_id: "wf-1", media_id: "m1", is_primary: true, role: "detail" });

        // Set with explicit null
        const result = await service.setPrimaryMedia({ workflowId: "wf-1", mediaId: null, userId: "u1" });
        assert.equal(result.is_primary, false);
        assert.equal(result.primaryMediaId, null);

        const wm1 = mockDb._store.workflowMedia.find((wm) => wm.media_id === "m1");
        assert.equal(wm1.is_primary, false, "Primary media must be cleared");

        // Direct clearPrimaryMedia method also works
        const clearRes = await service.clearPrimaryMedia({ workflowId: "wf-1", userId: "u1" });
        assert.equal(clearRes.is_primary, false);
        assert.equal(clearRes.primaryMediaId, null);
    });

    it("3. WorkflowMediaService rejects cross-tenant access with 404 per project rules", async () => {
        const mockDb = createMockDb();
        // user "attacker" does not own wf-1
        const authService = createMockAuthService(new Set(["legit-user:wf-1"]), new Set(["attacker:m1"]));
        const service = new WorkflowMediaService({ db: mockDb, authService, mediaUploadService: { discard: async () => ({}) } });

        mockDb._store.workflows.push({ id: "wf-1", user_id: "legit-user" });
        mockDb._store.media.push({ id: "m1", status: "completed", url: "https://example.com/1.png" });

        await assert.rejects(
            async () => {
                await service.setPrimaryMedia({ workflowId: "wf-1", mediaId: "m1", userId: "attacker" });
            },
            (err) => {
                assert.equal(err.statusCode, 404, "Cross-tenant access must return 404, never 403");
                return true;
            }
        );
    });

    it("4. WorkflowMediaService rejects media that does not belong to the workflow with 400 or 403", async () => {
        const mockDb = createMockDb();
        const authService = createMockAuthService(new Set(["u1:wf-1"]), new Set(["u1:m-foreign"]));
        const service = new WorkflowMediaService({ db: mockDb, authService, mediaUploadService: { discard: async () => ({}) } });

        mockDb._store.workflows.push({ id: "wf-1", user_id: "u1" });
        mockDb._store.media.push({ id: "m-foreign", status: "completed", url: "https://example.com/foreign.png" });
        // Notice m-foreign is NOT linked to wf-1 in workflowMedia

        await assert.rejects(
            async () => {
                await service.setPrimaryMedia({ workflowId: "wf-1", mediaId: "m-foreign", userId: "u1" });
            },
            (err) => {
                assert.ok(err.statusCode === 400 || err.statusCode === 403, "Foreign media must be rejected");
                return true;
            }
        );
    });

    it("5. WorkflowMediaRepository.setPrimaryMedia propagates genuine database failures", async () => {
        const repo = new WorkflowMediaRepository();
        repo._isMemoryMode = () => false;

        const fakeError = new Error("connection to database lost");
        fakeError.code = "08006"; // PostgreSQL connection failure

        repo._getClientOrThrow = () => ({
            rpc: async () => ({ data: null, error: fakeError }),
            from: () => {
                throw new Error("Should not reach fallback on genuine DB failure");
            },
        });

        await assert.rejects(
            async () => {
                await repo.setPrimaryMedia({ workflowId: "wf-1", mediaId: "m-1" });
            },
            (err) => {
                assert.equal(err.message, "connection to database lost");
                assert.equal(err.code, "08006");
                return true;
            }
        );
    });

    it("6. Element PATCH /api/v2/elements/:id with primaryMediaId switches Cover atomically", async () => {
        const mockDb = createMockDb();
        const mediaService = createTestElementMediaService(mockDb);
        const elementService = new ElementService({ db: mockDb, mediaService, assertOwns: async () => true });

        const { element } = await elementService.createElement({
            name: "Dragon Statue",
            projectId: "proj-1",
            userId: "user-1",
        });

        // Add 2 reference images
        const img1 = await mediaService.addReferenceMedia({
            elementId: element.id,
            imageUrl: "https://example.com/cover1.png",
            userId: "user-1",
        });
        const img2 = await mediaService.addReferenceMedia({
            elementId: element.id,
            imageUrl: "https://example.com/detail2.png",
            userId: "user-1",
        });

        // Initially img1 is Cover
        assert.equal(img1.media.is_primary, true);

        // Explicit switch to img2 using generic primaryMediaId
        const updated = await elementService.updateElement(
            element.id,
            { primaryMediaId: img2.media.id },
            "user-1"
        );

        assert.equal(updated.primaryMediaId, img2.media.id);
        assert.equal(updated.primary_media_url, "https://example.com/detail2.png");

        const primaryRelations = mockDb._store.workflowMedia.filter((wm) => wm.is_primary === true);
        assert.equal(primaryRelations.length, 1, "Exactly one primary relation allowed");
        assert.equal(primaryRelations[0].media_id, img2.media.id);
    });

    it("7. Element PATCH without primaryMediaId strictly preserves current Cover", async () => {
        const mockDb = createMockDb();
        const mediaService = createTestElementMediaService(mockDb);
        const elementService = new ElementService({ db: mockDb, mediaService, assertOwns: async () => true });

        const { element } = await elementService.createElement({
            name: "Ancient Shield",
            description: "Old shield description",
            projectId: "proj-1",
            userId: "user-1",
        });

        await mediaService.addReferenceMedia({
            elementId: element.id,
            imageUrl: "https://example.com/shield.png",
            userId: "user-1",
        });

        // PATCH description only (primaryMediaId omitted)
        const updated = await elementService.updateElement(
            element.id,
            { description: "New shield description" },
            "user-1"
        );

        assert.equal(updated.description, "New shield description");
        assert.equal(updated.primary_media_url, "https://example.com/shield.png", "Cover must remain unchanged when primaryMediaId is omitted");
    });

    it("8. Element PATCH with primaryMediaId: null explicitly clears the Cover", async () => {
        const mockDb = createMockDb();
        const mediaService = createTestElementMediaService(mockDb);
        const elementService = new ElementService({ db: mockDb, mediaService, assertOwns: async () => true });

        const { element } = await elementService.createElement({
            name: "Mystic Ring",
            projectId: "proj-1",
            userId: "user-1",
        });

        await mediaService.addReferenceMedia({
            elementId: element.id,
            imageUrl: "https://example.com/ring.png",
            userId: "user-1",
        });

        // Explicit clear via primaryMediaId: null
        const cleared = await elementService.updateElement(
            element.id,
            { primaryMediaId: null },
            "user-1"
        );

        assert.equal(cleared.primary_media_url, null);
        assert.equal(cleared.primaryMediaId, null);

        const primaries = mockDb._store.workflowMedia.filter((wm) => wm.is_primary === true);
        assert.equal(primaries.length, 0, "No primary media after explicit null");
    });

    it("9. Initial assignment (first upload) does NOT overwrite an established primary", async () => {
        const mockDb = createMockDb();
        const mediaService = createTestElementMediaService(mockDb);
        const elementService = new ElementService({ db: mockDb, mediaService, assertOwns: async () => true });

        const { element } = await elementService.createElement({
            name: "Crystal Bow",
            projectId: "proj-1",
            userId: "user-1",
        });

        // First upload becomes Cover
        const first = await mediaService.addReferenceMedia({
            elementId: element.id,
            imageUrl: "https://example.com/bow1.png",
            userId: "user-1",
        });
        assert.equal(first.media.is_primary, true);

        // Second upload must NOT overwrite Cover
        const second = await mediaService.addReferenceMedia({
            elementId: element.id,
            imageUrl: "https://example.com/bow2.png",
            userId: "user-1",
        });
        assert.equal(second.media.is_primary, false, "Subsequent upload must not become primary");

        const primaryLinks = mockDb._store.workflowMedia.filter((wm) => wm.is_primary === true);
        assert.equal(primaryLinks.length, 1);
        assert.equal(primaryLinks[0].media_id, first.media.id);
    });

    it("10. Deleting primary media does NOT auto-promote another media; primary_media_url becomes null", async () => {
        const mockDb = createMockDb();
        const mediaService = createTestElementMediaService(mockDb);
        const elementService = new ElementService({ db: mockDb, mediaService, assertOwns: async () => true });

        const { element } = await elementService.createElement({
            name: "Staff of Ages",
            projectId: "proj-1",
            userId: "user-1",
        });

        const cover = await mediaService.addReferenceMedia({
            elementId: element.id,
            imageUrl: "https://example.com/staff_cover.png",
            userId: "user-1",
        });
        await mediaService.addReferenceMedia({
            elementId: element.id,
            imageUrl: "https://example.com/staff_detail.png",
            userId: "user-1",
        });

        // Delete the Cover
        await mediaService.removeReferenceMedia({
            elementId: element.id,
            mediaId: cover.media.id,
            userId: "user-1",
        });

        const refreshed = await elementService.getElementById(element.id);
        assert.equal(refreshed.primary_media_url, null, "Deleting Cover must leave primary_media_url: null");

        const primaryLinks = mockDb._store.workflowMedia.filter((wm) => wm.is_primary === true);
        assert.equal(primaryLinks.length, 0, "Zero auto-promotion; no media is marked primary");
    });

    it("11. Controller PATCH /api/workflows/:id/primary-media supports primaryMediaId in req.body", async () => {
        const { setPrimaryMedia } = await import("#generation/api");
        const { workflowService } = await import("../../../src/container.js");

        let invokedParams = null;
        const originalSetPrimary = workflowService.setPrimaryMedia;
        workflowService.setPrimaryMedia = async (params) => {
            invokedParams = params;
            return { primary_media_id: params.mediaId, primaryMediaId: params.mediaId };
        };

        try {
            let jsonResponse = null;
            let statusCode = 200;
            const req = {
                params: { id: "wf-ctrl-test" },
                body: { primaryMediaId: "media-uuid-999" },
                user: { id: "user-test" },
            };
            const res = {
                status: (code) => { statusCode = code; return res; },
                json: (payload) => { jsonResponse = payload; return res; },
            };

            await setPrimaryMedia(req, res);

            assert.equal(statusCode, 200);
            assert.equal(invokedParams?.mediaId, "media-uuid-999");
            assert.equal(jsonResponse?.ok, true);
            assert.equal(jsonResponse?.primaryMediaId, "media-uuid-999");
            assert.equal(jsonResponse?.primary_media_id, "media-uuid-999");
        } finally {
            workflowService.setPrimaryMedia = originalSetPrimary;
        }
    });
});
function createTestElementMediaService(mockDb) {
    const mockUploadService = {
        upload: async ({ files }) => ({
            uploaded: files.map((f, idx) => {
                const url = typeof f === "string" ? f : (f?.url || "https://example.com/uploaded.png");
                return { id: "media-upload-" + Date.now() + "-" + (idx + 1), url, step_id: "upload" };
            }),
        }),
        discard: async () => ({}),
    };
    const mockWorkflowMediaService = {
        attachMediaItems: async ({ workflowId, items, role = "detail", autoPrimary = true }) => {
            const attached = [];
            for (const item of items) {
                const existing = await mockDb.workflowMedia.findByWorkflow(workflowId);
                const isFirst = existing.length === 0;
                const isPrimary = isFirst && autoPrimary;
                const m = await mockDb.media.createMedia({
                    url: item.uploadedFile?.url || "https://example.com/m.png",
                    step_id: "upload",
                });
                const link = await mockDb.workflowMedia.linkMedia({
                    workflowId,
                    mediaId: m.id,
                    role,
                    is_primary: isPrimary,
                });
                attached.push({ media: m, link, is_primary: isPrimary });
            }
            return { attached };
        },
    };
    const mockAuthService = {
        verifyWorkflowOwnership: async () => true,
    };
    return new ElementMediaService({
        db: mockDb,
        storageService: {},
        mediaUploadService: mockUploadService,
        workflowMediaService: mockWorkflowMediaService,
        authService: mockAuthService,
    });
}
}

// ─── Source: sharedMediaConcurrencySafetyBoundary.test.js ───
{
/**
 * Concurrency Safety & Orphan Cleanup Boundary Tests
 *
 * Tests the race conditions identified in the verification audit:
 * 1. Two concurrent unlink requests for the same media.
 * 2. An attach racing with the final unlink and orphan cleanup.
 * 3. An attach completing before cleanup starts.
 * 4. The existing shared-media invariant: deleting workflow A's association preserves workflow B's association and asset.
 * 5. A genuine orphan being cleaned up exactly once.
 */
describe("Shared-Media Concurrency Safety & Atomic Orphan Cleanup", () => {
  beforeEach(() => {
    WorkflowMediaRepository.enableTestMemoryFallback();
    WorkflowMediaRepository.clearMemory();
  });

  it("TEST 1: Two concurrent unlinks of the same media execute safely and reap storage exactly once", async () => {
    const repo = new WorkflowMediaRepository();
    const mediaId = "media-concurrent-1";
    const wfId = "wf-concurrent-1";
    const userId = "user-1";
    const storageUrl = "https://storage.local/media-concurrent-1.png";

    await repo.linkMedia({ workflowId: wfId, mediaId, role: "output" });

    const deletedStorage = [];
    const mediaStore = new Map([[mediaId, { id: mediaId, url: storageUrl }]]);

    const mockDb = {
      workflowMedia: repo,
      media: {
        findById: async (id) => mediaStore.get(id) || null,
        deleteById: async (id) => {
          mediaStore.delete(id);
          return { id };
        },
        findByWorkflow: async () => [],
      },
      workflows: {
        findById: async () => ({ id: wfId, primary_media_id: null }),
        deleteById: async () => {},
        updatePrimaryMedia: async () => {},
      },
    };

    const mockStorage = {
      deleteByUrl: async (url) => {
        // Simulate real network latency on storage delete
        await new Promise((resolve) => setTimeout(resolve, 10));
        deletedStorage.push(url);
      },
    };

    const mockAuth = {
      verifyWorkflowOwnership: async () => true,
      verifyMediaOwnership: async () => true,
    };

    const service = new WorkflowMediaService({
      db: mockDb,
      storageService: mockStorage,
      authService: mockAuth,
      mediaUploadService: { discard: async () => ({}) },
    });

    // Fire two simultaneous deleteMedia requests for the exact same media
    const [res1, res2] = await Promise.all([
      service.deleteMedia({ workflowId: wfId, mediaId, userId }),
      service.deleteMedia({ workflowId: wfId, mediaId, userId }),
    ]);

    // Storage file must be deleted EXACTLY ONCE
    assert.equal(
      deletedStorage.length,
      1,
      `Storage file must be deleted exactly once across concurrent unlinks, but was deleted ${deletedStorage.length} times`
    );

    // Exactly one call should report having deleted the media record
    const deleteSuccessCount = [res1.deleted, res2.deleted].filter(Boolean).length;
    assert.equal(
      deleteSuccessCount,
      1,
      `Exactly one caller must report deleted=true, but ${deleteSuccessCount} did`
    );
  });

  it("TEST 2: An attach racing with the final unlink preserves the media row and storage asset", async () => {
    const repo = new WorkflowMediaRepository();
    const mediaId = "media-race-attach";
    const wfA = "wf-race-a";
    const wfB = "wf-race-b";
    const userId = "user-1";
    const storageUrl = "https://storage.local/media-race-attach.png";

    // Media initially linked only to wfA
    await repo.linkMedia({ workflowId: wfA, mediaId, role: "output" });

    const deletedStorage = [];
    const mediaStore = new Map([[mediaId, { id: mediaId, url: storageUrl }]]);

    // Hook unlink to simulate a concurrent attach occurring during the unlink process
    const originalUnlink = repo.unlink.bind(repo);
    let attachDone = false;

    const mockDb = {
      workflowMedia: repo,
      media: {
        findById: async (id) => mediaStore.get(id) || null,
        deleteById: async (id) => {
          mediaStore.delete(id);
          return { id };
        },
        findByWorkflow: async () => [],
      },
      workflows: {
        findById: async () => ({ id: wfA, primary_media_id: null }),
        deleteById: async () => {},
        updatePrimaryMedia: async () => {},
      },
    };

    const mockStorage = {
      deleteByUrl: async (url) => {
        deletedStorage.push(url);
      },
    };

    const mockAuth = {
      verifyWorkflowOwnership: async () => true,
      verifyMediaOwnership: async () => true,
    };

    const service = new WorkflowMediaService({
      db: mockDb,
      storageService: mockStorage,
      authService: mockAuth,
      mediaUploadService: { discard: async () => ({}) },
    });

    // Simulate concurrent attach to Workflow B racing with the unlink-and-reap operation
    const originalReap = repo.unlinkAndReapOrphan.bind(repo);
    repo.unlinkAndReapOrphan = async (args) => {
      // Concurrent attach races in: Workflow B establishes its association
      await repo.linkMedia({ workflowId: wfB, mediaId, role: "reference" });
      attachDone = true;
      return originalReap(args);
    };

    const result = await service.deleteMedia({ workflowId: wfA, mediaId, userId });

    // Since Workflow B attached the media, it is NOT an orphan
    assert.equal(attachDone, true, "Concurrent attach must have executed");
    assert.equal(result.deleted, false, "Media must NOT be reported as deleted when racing attach references it");
    assert.equal(deletedStorage.length, 0, "Storage file must NOT be deleted when a concurrent attach holds a reference");
    assert.equal(mediaStore.has(mediaId), true, "Media database row must remain in media table");

    const linksB = await repo.findByWorkflow(wfB);
    assert.equal(linksB.some((r) => r.media_id === mediaId), true, "Workflow B must still hold active association");
  });

  it("TEST 3: An attach completing before cleanup starts preserves shared media", async () => {
    const repo = new WorkflowMediaRepository();
    const mediaId = "media-attach-before";
    const wfA = "wf-ab-1";
    const wfB = "wf-ab-2";
    const userId = "user-1";
    const storageUrl = "https://storage.local/media-attach-before.png";

    await repo.linkMedia({ workflowId: wfA, mediaId, role: "output" });
    await repo.linkMedia({ workflowId: wfB, mediaId, role: "detail" });

    const deletedStorage = [];
    const mediaStore = new Map([[mediaId, { id: mediaId, url: storageUrl }]]);

    const mockDb = {
      workflowMedia: repo,
      media: {
        findById: async (id) => mediaStore.get(id) || null,
        deleteById: async (id) => {
          mediaStore.delete(id);
          return { id };
        },
        findByWorkflow: async () => [],
      },
      workflows: {
        findById: async () => ({ id: wfA, primary_media_id: null }),
        deleteById: async () => {},
        updatePrimaryMedia: async () => {},
      },
    };

    const mockStorage = {
      deleteByUrl: async (url) => {
        deletedStorage.push(url);
      },
    };

    const mockAuth = {
      verifyWorkflowOwnership: async () => true,
      verifyMediaOwnership: async () => true,
    };

    const service = new WorkflowMediaService({
      db: mockDb,
      storageService: mockStorage,
      authService: mockAuth,
      mediaUploadService: { discard: async () => ({}) },
    });

    const result = await service.deleteMedia({ workflowId: wfA, mediaId, userId });

    assert.equal(result.deleted, false);
    assert.equal(deletedStorage.length, 0);
    assert.equal(mediaStore.has(mediaId), true);
    assert.equal(await repo.countLinksForMedia(mediaId), 1);
  });

  it("TEST 4: Removing workflow A's association preserves workflow B's association and asset", async () => {
    const repo = new WorkflowMediaRepository();
    const mediaId = "media-shared-preserve";
    const wfA = "wf-preserve-a";
    const wfB = "wf-preserve-b";
    const userId = "user-1";
    const storageUrl = "https://storage.local/media-shared-preserve.png";

    await repo.linkMedia({ workflowId: wfA, mediaId, role: "output" });
    await repo.linkMedia({ workflowId: wfB, mediaId, role: "reference" });

    const deletedStorage = [];
    const mediaStore = new Map([[mediaId, { id: mediaId, url: storageUrl }]]);

    const mockDb = {
      workflowMedia: repo,
      media: {
        findById: async (id) => mediaStore.get(id) || null,
        deleteById: async (id) => {
          mediaStore.delete(id);
          return { id };
        },
        findByWorkflow: async () => [],
      },
      workflows: {
        findById: async () => ({ id: wfA, primary_media_id: null }),
        deleteById: async () => {},
        updatePrimaryMedia: async () => {},
      },
    };

    const mockStorage = {
      deleteByUrl: async (url) => {
        deletedStorage.push(url);
      },
    };

    const mockAuth = {
      verifyWorkflowOwnership: async () => true,
      verifyMediaOwnership: async () => true,
    };

    const service = new WorkflowMediaService({
      db: mockDb,
      storageService: mockStorage,
      authService: mockAuth,
      mediaUploadService: { discard: async () => ({}) },
    });

    const result = await service.deleteMedia({ workflowId: wfA, mediaId, userId });

    assert.equal(result.deleted, false);
    assert.equal(deletedStorage.length, 0);
    assert.equal(mediaStore.has(mediaId), true);

    const wfBLinks = await repo.findByWorkflow(wfB);
    assert.equal(wfBLinks.some((l) => l.media_id === mediaId), true);

    const wfALinks = await repo.findByWorkflow(wfA);
    assert.equal(wfALinks.some((l) => l.media_id === mediaId), false);
  });

  it("TEST 5: A genuine orphan is cleaned up exactly once and storage is deleted", async () => {
    const repo = new WorkflowMediaRepository();
    const mediaId = "media-orphan-clean";
    const wfA = "wf-orphan-only";
    const userId = "user-1";
    const storageUrl = "https://storage.local/media-orphan-clean.png";

    await repo.linkMedia({ workflowId: wfA, mediaId, role: "output" });

    const deletedStorage = [];
    const mediaStore = new Map([[mediaId, { id: mediaId, url: storageUrl }]]);

    const mockDb = {
      workflowMedia: repo,
      media: {
        findById: async (id) => mediaStore.get(id) || null,
        deleteById: async (id) => {
          mediaStore.delete(id);
          return { id };
        },
        findByWorkflow: async () => [],
      },
      workflows: {
        findById: async () => ({ id: wfA, primary_media_id: null }),
        deleteById: async () => {},
        updatePrimaryMedia: async () => {},
      },
    };

    const mockStorage = {
      deleteByUrl: async (url) => {
        deletedStorage.push(url);
      },
    };

    const mockAuth = {
      verifyWorkflowOwnership: async () => true,
      verifyMediaOwnership: async () => true,
    };

    const service = new WorkflowMediaService({
      db: mockDb,
      storageService: mockStorage,
      authService: mockAuth,
      mediaUploadService: { discard: async () => ({}) },
    });

    const result = await service.deleteMedia({ workflowId: wfA, mediaId, userId });

    assert.equal(result.deleted, true);
    assert.deepEqual(deletedStorage, [storageUrl]);
    assert.equal(mediaStore.has(mediaId), false);
    assert.equal(await repo.countLinksForMedia(mediaId), 0);
  });
});
}

// ─── Source: sharedMediaUnlinkSafeFallbackBoundary.test.js ───
{
describe("Shared-Media Unlink Safe Fallback & Schema Integrity Boundary", () => {
  it("TEST 1: Missing RPC (error 42883) fails closed with SERVICE_UNAVAILABLE and preserves storage", async () => {
    const deletedStorage = [];
    const mediaId = "media-missing-rpc-1";
    const wfId = "wf-missing-rpc-1";
    const userId = "user-1";
    const storageUrl = "https://storage.local/media-missing-rpc-1.png";

    // Mock repository with client returning error code 42883 (undefined_function)
    const mockClient = {
      from: () => ({
        delete: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
        select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
      }),
      rpc: async (funcName) => {
        if (funcName === "unlink_workflow_media_and_reap_orphan") {
          const err = new Error("function public.unlink_workflow_media_and_reap_orphan(uuid, uuid, text) does not exist");
          err.code = "42883";
          return { data: null, error: err };
        }
        return { data: null, error: null };
      },
    };

    const repo = new WorkflowMediaRepository();
    repo.client = () => mockClient;

    const mockDb = {
      workflowMedia: repo,
      media: {
        findById: async () => ({ id: mediaId, url: storageUrl }),
        deleteById: async () => {
          throw new Error("deleteById should not be called when RPC fails closed");
        },
      },
      workflows: {
        findById: async () => ({ id: wfId, primary_media_id: null }),
        deleteById: async () => {},
        updatePrimaryMedia: async () => {},
      },
    };

    const mockStorage = {
      deleteByUrl: async (url) => {
        deletedStorage.push(url);
      },
    };

    const mockAuth = {
      verifyWorkflowOwnership: async () => true,
      verifyMediaOwnership: async () => true,
    };

    const service = new WorkflowMediaService({
      db: mockDb,
      storageService: mockStorage,
      authService: mockAuth,
      mediaUploadService: { discard: async () => ({}) },
    });

    // Calling deleteMedia when atomic RPC is missing must FAIL CLOSED
    await assert.rejects(
      async () => {
        await service.deleteMedia({ workflowId: wfId, mediaId, userId });
      },
      (err) => {
        assert.ok(err instanceof CrudServiceError || err.statusCode === 503 || err.code === "RPC_UNAVAILABLE" || err.errorCode === "SERVICE_UNAVAILABLE", `Expected 503/SERVICE_UNAVAILABLE, got: ${err.message}`);
        return true;
      }
    );

    // Physical storage file must NEVER be deleted
    assert.equal(deletedStorage.length, 0, "Storage must NOT be deleted when atomic RPC is unavailable");
  });

  it("TEST 2: Unexpected schema error (e.g. 42703 undefined_column) propagates and does NOT trigger fallback", async () => {
    const deletedStorage = [];
    const mediaId = "media-col-err-1";
    const wfId = "wf-col-err-1";
    const userId = "user-1";
    const storageUrl = "https://storage.local/media-col-err-1.png";

    // Simulate PostgreSQL error 42703 (undefined_column: column "primary_media_id" of relation "workflow" does not exist)
    const mockClient = {
      from: () => ({
        delete: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
        select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
      }),
      rpc: async (funcName) => {
        if (funcName === "unlink_workflow_media_and_reap_orphan") {
          const err = new Error('column "primary_media_id" of relation "workflow" does not exist');
          err.code = "42703";
          return { data: null, error: err };
        }
        return { data: null, error: null };
      },
    };

    const repo = new WorkflowMediaRepository();
    repo.client = () => mockClient;

    const mockDb = {
      workflowMedia: repo,
      media: {
        findById: async () => ({ id: mediaId, url: storageUrl }),
        deleteById: async () => {},
      },
      workflows: {
        findById: async () => ({ id: wfId, primary_media_id: null }),
        deleteById: async () => {},
        updatePrimaryMedia: async () => {},
      },
    };

    const mockStorage = {
      deleteByUrl: async (url) => {
        deletedStorage.push(url);
      },
    };

    const mockAuth = {
      verifyWorkflowOwnership: async () => true,
      verifyMediaOwnership: async () => true,
    };

    const service = new WorkflowMediaService({
      db: mockDb,
      storageService: mockStorage,
      authService: mockAuth,
      mediaUploadService: { discard: async () => ({}) },
    });

    // The unexpected schema error must propagate, NOT be swallowed or treated as missing RPC
    await assert.rejects(
      async () => {
        await service.deleteMedia({ workflowId: wfId, mediaId, userId });
      },
      (err) => {
        // Must indicate schema/database error, not a successful fallback
        assert.ok(
          err.code === "42703" || err.message?.includes("primary_media_id") || err.statusCode === 500,
          `Expected 42703 error to propagate, got: ${err.message}`
        );
        return true;
      }
    );

    assert.equal(deletedStorage.length, 0, "Storage must not be touched on database schema error");
  });

  it("TEST 3: Fallback sequential unlink does not authorize storage deletion even if count is 0", async () => {
    // If unlinkAndReapOrphan is invoked in a non-atomic environment, it must NEVER report is_orphan: true
    const repo = new WorkflowMediaRepository();
    // Simulate non-RPC mode where unlinkAndReapOrphan is explicitly invoked
    const mockClient = {
      from: () => ({
        delete: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
        select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
      }),
      rpc: async () => ({
        data: null,
        error: Object.assign(new Error("RPC unavailable"), { code: "42883" }),
      }),
    };
    repo.client = () => mockClient;

    await assert.rejects(
      async () => {
        await repo.unlinkAndReapOrphan({ workflowId: "wf-1", mediaId: "media-1" });
      },
      (err) => {
        assert.ok(
          err.code === "RPC_UNAVAILABLE" || err.statusCode === 503 || err.message?.includes("unavailable"),
          `Expected RPC_UNAVAILABLE rejection, got ${err.message}`
        );
        return true;
      }
    );
  });

  it("TEST 4: WorkflowMediaRepository.attachReferenceMedia coordinates via atomic RPC and respects quota", async () => {
    const repo = new WorkflowMediaRepository();
    let rpcCalledWith = null;

    const mockClient = {
      from: () => ({
        select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }),
      }),
      rpc: async (name, params) => {
        if (name === "attach_workflow_reference_media") {
          rpcCalledWith = params;
          return {
            data: {
              workflow_id: params.p_workflow_id,
              media_id: params.p_media_id,
              role: params.p_role,
              is_primary: true,
              current_count: 1,
              max_allowed: params.p_max_allowed,
            },
            error: null,
          };
        }
        return { data: null, error: null };
      },
    };
    repo.client = () => mockClient;

    const result = await repo.attachReferenceMedia({
      workflowId: "wf-ref-1",
      mediaId: "media-ref-1",
      role: "detail",
      maxAllowed: 6,
    });

    assert.ok(rpcCalledWith, "RPC attach_workflow_reference_media must be invoked");
    assert.equal(rpcCalledWith.p_workflow_id, "wf-ref-1");
    assert.equal(rpcCalledWith.p_media_id, "media-ref-1");
    assert.equal(rpcCalledWith.p_max_allowed, 6);
    assert.equal(result.is_primary, true);
  });

  it("TEST 5: attachReferenceMedia enforces strict quota under memory mode", async () => {
    WorkflowMediaRepository.enableTestMemoryFallback();
    WorkflowMediaRepository.clearMemory();
    const repo = new WorkflowMediaRepository();

    const wfId = "wf-quota-test";
    // Attach 6 reference images
    for (let i = 1; i <= 6; i++) {
      await repo.attachReferenceMedia({
        workflowId: wfId,
        mediaId: `media-slot-${i}`,
        role: "detail",
        maxAllowed: 6,
      });
    }

    // 7th image must be rejected with quota limit error
    await assert.rejects(
      async () => {
        await repo.attachReferenceMedia({
          workflowId: wfId,
          mediaId: "media-slot-7",
          role: "detail",
          maxAllowed: 6,
        });
      },
      (err) => {
        assert.ok(err.code === "23514" || err.message?.includes("Maximum 6"), `Expected quota limit error, got: ${err.message}`);
        return true;
      }
    );
  });
});
}

// ─── Source: sharedMediaLifecycleRegression.test.js ───
{
/**
 * Regression test: shared-media lifecycle correctness
 *
 * Requirements:
 * 1. Remove association first; delete media asset ONLY when zero associations remain anywhere.
 * 2. Delete only the specific workflow_media association identified by both workflow_id and media_id.
 *    Never globally unlink every relation matching only media_id.
 * 3. One media linked to workflows A and B; unlinking it from A leaves B and the binary intact.
 * 4. Unlinking the last remaining association deletes the media row and binary.
 * 5. Primary-media behavior:
 *    - Removing a non-primary association must not change another workflow's primary.
 *    - Removing the primary association must not auto-promote another image.
 *    - Removing a primary from A does not affect B's primary state.
 * 6. Database errors must propagate explicitly without swallowing failures or deleting media prematurely.
 * 7. Unauthorized / cross-tenant / missing entity removal returns 404.
 */

describe("Shared-Media Lifecycle Regression & Hardening", () => {

    beforeEach(() => {
        WorkflowMediaRepository.enableTestMemoryFallback();
        WorkflowMediaRepository.clearMemory();
    });

    afterEach(() => {
        WorkflowMediaRepository.clearMemory();
        WorkflowMediaRepository.disableTestMemoryFallback();
    });

    // ─── Real WorkflowMediaRepository Integration ─────────────────────────────

    it("Real WorkflowMediaRepository: Media linked to workflows A and B; unlinking from A leaves B and media intact", async () => {
        const repo = new WorkflowMediaRepository();
        const deletedMediaIds = [];
        const storageDeletes = [];

        const mediaId = "11111111-2222-3333-4444-555555555555";
        const wfA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        const wfB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

        // Link mediaId to both workflow A (primary) and workflow B (non-primary)
        await repo.linkMedia({ workflowId: wfA, mediaId, role: "detail", is_primary: true });
        await repo.linkMedia({ workflowId: wfB, mediaId, role: "detail", is_primary: false });

        assert.equal(await repo.countLinksForMedia(mediaId), 2);
        assert.equal((await repo.getPrimaryMedia(wfA))?.media_id, mediaId);

        const mockDb = {
            elements: {
                resolveRecord: async (id) => (id === "elem-A" ? { id: "elem-A", workflow_id: wfA } : null),
            },
            workflows: {
                findById: async (id) => ({ id }),
            },
            media: {
                findById: async (id) => ({ id, url: `https://storage.cdn/${id}.png` }),
                deleteById: async (id) => { deletedMediaIds.push(id); },
            },
            workflowMedia: repo,
        };

        const storageService = {
            deleteByUrl: async (url) => { storageDeletes.push(url); },
        };

        const elementMediaService = new ElementMediaService({
            db: mockDb,
            storageService,
            mediaUploadService: { upload: async () => ({ files: [], uploaded: [] }), discard: async () => ({}) },
            workflowMediaService: { attachMediaItems: async () => ({ attached: [] }) },
            authService: { verifyWorkflowOwnership: async () => true },
        });

        // Unlink from Element A
        const result = await elementMediaService.removeReferenceMedia({
            elementId: "elem-A",
            mediaId,
            userId: "user-1",
        });

        assert.equal(result.ok, true);

        // Workflow A should no longer have the relation or primary
        assert.equal(await repo.isMediaLinkedToWorkflow({ workflowId: wfA, mediaId }), false);
        assert.equal(await repo.getPrimaryMedia(wfA), null);

        // Workflow B MUST still have the relation!
        assert.equal(await repo.isMediaLinkedToWorkflow({ workflowId: wfB, mediaId }), true);
        assert.equal(await repo.countLinksForMedia(mediaId), 1);

        // Media row and storage MUST NOT be deleted
        assert.deepEqual(deletedMediaIds, [], "Media row must remain intact while linked to workflow B");
        assert.deepEqual(storageDeletes, [], "Storage file must remain intact while linked to workflow B");

        // Now unlink from workflow B (last remaining link)
        mockDb.elements.resolveRecord = async (id) => (id === "elem-B" ? { id: "elem-B", workflow_id: wfB } : null);

        const result2 = await elementMediaService.removeReferenceMedia({
            elementId: "elem-B",
            mediaId,
            userId: "user-1",
        });

        assert.equal(result2.ok, true);
        assert.equal(await repo.countLinksForMedia(mediaId), 0);

        // Media row and storage MUST now be deleted
        assert.deepEqual(deletedMediaIds, [mediaId], "Media row must be deleted when count is 0");
        assert.deepEqual(storageDeletes, [`https://storage.cdn/${mediaId}.png`], "Storage file must be deleted when count is 0");
    });

    it("Real WorkflowMediaRepository: Removing primary from workflow A preserves workflow B primary state", async () => {
        const repo = new WorkflowMediaRepository();
        const mediaA = "11111111-0000-0000-0000-000000000001";
        const mediaB = "22222222-0000-0000-0000-000000000002";
        const wfA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        const wfB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

        // wfA has mediaA as primary
        await repo.linkMedia({ workflowId: wfA, mediaId: mediaA, role: "detail", is_primary: true });
        // wfB has mediaB as primary
        await repo.linkMedia({ workflowId: wfB, mediaId: mediaB, role: "detail", is_primary: true });

        const mockDb = {
            elements: {
                resolveRecord: async (id) => (id === "elem-A" ? { id: "elem-A", workflow_id: wfA } : null),
            },
            workflows: {
                findById: async (id) => ({ id }),
            },
            media: {
                findById: async (id) => ({ id, url: `https://storage.cdn/${id}.png` }),
                deleteById: async () => {},
            },
            workflowMedia: repo,
        };

        const elementMediaService = new ElementMediaService({ db: mockDb, storageService: { deleteByUrl: async () => {} }, mediaUploadService: { upload: async () => ({ files: [], uploaded: [] }), discard: async () => ({}) }, workflowMediaService: { attachMediaItems: async () => ({ attached: [] }) }, authService: { verifyWorkflowOwnership: async () => true } });

        await elementMediaService.removeReferenceMedia({
            elementId: "elem-A",
            mediaId: mediaA,
            userId: "user-1",
        });

        // wfA primary is cleared
        assert.equal(await repo.getPrimaryMedia(wfA), null);

        // wfB primary is COMPLETELY UNTOUCHED
        const primaryB = await repo.getPrimaryMedia(wfB);
        assert.equal(primaryB?.media_id, mediaB, "Workflow B primary must not be modified when unlinking from workflow A");
    });

    // ─── CharacterMediaService Primary Preservation ───────────────────────────

    it("CharacterMediaService.removeDetailMedia: does NOT clear primary when removed media is non-primary", async () => {
        const clearCalls = [];
        const service = new CharacterMediaService({
            mediaUploadService: { upload: async () => ({}) },
            workflowMediaService: { attachMediaItems: async () => ({}) },
            authService: { verifyWorkflowOwnership: async () => true },
            db: {
                workflows: {
                    getWorkflow: async (id) => ({ id, user_id: "u1" }),
                },
                media: {
                    findById: async (id) => ({ id, url: "https://cdn/img.png", role: "detail", mediaRole: "detail" }),
                    deleteById: async () => {},
                },
                workflowMedia: {
                    findByMedia: async () => [{ workflow_id: "wf-1", media_id: "m-detail", role: "detail" }],
                    unlink: async () => {},
                    countLinksForMedia: async () => 0,
                    getPrimaryMedia: async () => ({ media_id: "m-OTHER-PRIMARY" }),
                    clearPrimaryMedia: async (args) => { clearCalls.push(args); },
                },
            },
            storageService: { deleteByUrl: async () => {} },
        });

        await service.removeDetailMedia({
            characterId: "wf-1",
            mediaId: "m-detail",
            userId: "u1",
        });

        assert.equal(clearCalls.length, 0, "clearPrimaryMedia must NOT be called for non-primary media");
    });

    it("CharacterMediaService.removeDetailMedia: clears primary only when removed media IS primary", async () => {
        const clearCalls = [];
        const service = new CharacterMediaService({
            mediaUploadService: { upload: async () => ({}) },
            workflowMediaService: { attachMediaItems: async () => ({}) },
            authService: { verifyWorkflowOwnership: async () => true },
            db: {
                workflows: {
                    getWorkflow: async (id) => ({ id, user_id: "u1" }),
                },
                media: {
                    findById: async (id) => ({ id, url: "https://cdn/img.png", role: "detail", mediaRole: "detail" }),
                    deleteById: async () => {},
                },
                workflowMedia: {
                    findByMedia: async () => [{ workflow_id: "wf-1", media_id: "m-primary", role: "detail" }],
                    unlink: async () => {},
                    countLinksForMedia: async () => 0,
                    getPrimaryMedia: async () => ({ media_id: "m-primary" }),
                    clearPrimaryMedia: async (args) => { clearCalls.push(args); },
                },
            },
            storageService: { deleteByUrl: async () => {} },
        });

        await service.removeDetailMedia({
            characterId: "wf-1",
            mediaId: "m-primary",
            userId: "u1",
        });

        assert.equal(clearCalls.length, 1, "clearPrimaryMedia must be called when removed media is primary");
        assert.deepEqual(clearCalls[0], { workflowId: "wf-1" });
    });

    // ─── Database Error Handling & No Swallowing ──────────────────────────────

    it("ElementMediaService.removeReferenceMedia: DB error in unlink propagates and does NOT delete media", async () => {
        let mediaDeleted = false;
        let storageDeleted = false;

        const service = new ElementMediaService({
            mediaUploadService: { upload: async () => ({ files: [], uploaded: [] }), discard: async () => ({}) },
            workflowMediaService: { attachMediaItems: async () => ({ attached: [] }) },
            authService: { verifyWorkflowOwnership: async () => true },
            storageService: {},
            db: {
                elements: {
                    resolveRecord: async () => ({ id: "elem-1", workflow_id: "wf-1" }),
                },
                workflows: {
                    findById: async () => ({ id: "wf-1" }),
                },
                media: {
                    findById: async () => ({ id: "m-1", url: "https://cdn/1.png" }),
                    deleteById: async () => { mediaDeleted = true; },
                },
                workflowMedia: {
                    unlinkAndReapOrphan: async () => {
                        throw new Error("PostgreSQL connection terminated unexpectedly");
                    },
                },
            },
            storageService: {
                deleteByUrl: async () => { storageDeleted = true; },
            },
        });

        await assert.rejects(
            () => service.removeReferenceMedia({ elementId: "elem-1", mediaId: "m-1", userId: "u1" }),
            (err) => err.message.includes("PostgreSQL connection terminated"),
            "Database error in unlink must propagate to caller"
        );

        assert.equal(mediaDeleted, false, "Media must NOT be deleted if unlink throws");
        assert.equal(storageDeleted, false, "Storage must NOT be deleted if unlink throws");
    });

    it("ElementMediaService.removeReferenceMedia: DB error in unlinkAndReapOrphan propagates and does NOT delete media", async () => {
        let mediaDeleted = false;
        let storageDeleted = false;

        const service = new ElementMediaService({
            mediaUploadService: { upload: async () => ({ files: [], uploaded: [] }), discard: async () => ({}) },
            workflowMediaService: { attachMediaItems: async () => ({ attached: [] }) },
            authService: { verifyWorkflowOwnership: async () => true },
            storageService: {},
            db: {
                elements: {
                    resolveRecord: async () => ({ id: "elem-1", workflow_id: "wf-1" }),
                },
                workflows: {
                    findById: async () => ({ id: "wf-1" }),
                },
                media: {
                    findById: async () => ({ id: "m-1", url: "https://cdn/1.png" }),
                    deleteById: async () => { mediaDeleted = true; },
                },
                workflowMedia: {
                    unlinkAndReapOrphan: async () => {
                        throw new Error("Database timeout executing unlink_and_reap_orphan");
                    },
                },
            },
            storageService: {
                deleteByUrl: async () => { storageDeleted = true; },
            },
        });

        await assert.rejects(
            () => service.removeReferenceMedia({ elementId: "elem-1", mediaId: "m-1", userId: "u1" }),
            (err) => err.message.includes("Database timeout executing unlink_and_reap_orphan"),
            "Database error in unlinkAndReapOrphan must propagate to caller"
        );

        assert.equal(mediaDeleted, false, "Media must NOT be deleted if link count query fails");
        assert.equal(storageDeleted, false, "Storage must NOT be deleted if link count query fails");
    });

    // ─── Scope & Tenant Isolation ─────────────────────────────────────────────

    it("ElementMediaService.removeReferenceMedia: returns 404 when element not found", async () => {
        let unlinkCalled = false;

        const service = new ElementMediaService({
            mediaUploadService: { upload: async () => ({ files: [], uploaded: [] }), discard: async () => ({}) },
            workflowMediaService: { attachMediaItems: async () => ({ attached: [] }) },
            authService: { verifyWorkflowOwnership: async () => true },
            storageService: {},
            db: {
                elements: {
                    resolveRecord: async () => null,
                },
                workflowMedia: {
                    unlink: async () => { unlinkCalled = true; },
                },
            },
        });

        await assert.rejects(
            () => service.removeReferenceMedia({ elementId: "nonexistent-elem", mediaId: "m-1", userId: "u1" }),
            (err) => {
                assert.equal(err.statusCode, 404);
                assert.equal(err.errorCode, "NOT_FOUND");
                return true;
            }
        );

        assert.equal(unlinkCalled, false, "Must NEVER call unlink when element is not found");
    });

    // ─── WorkflowMediaService.deleteMedia Shared Lifecycle ───────────────────

    it("WorkflowMediaService.deleteMedia: when workflowId provided for shared media, unlinks ONLY from that workflow and preserves media and storage", async () => {
        const repo = new WorkflowMediaRepository();
        const mediaId = "11111111-2222-3333-4444-555555555555";
        const wfA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
        const wfB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

        // Link media to wfA and wfB
        await repo.linkMedia({ workflowId: wfA, mediaId, role: "detail", is_primary: false });
        await repo.linkMedia({ workflowId: wfB, mediaId, role: "detail", is_primary: true });

        assert.equal(await repo.countLinksForMedia(mediaId), 2);

        const deletedMediaIds = [];
        const deletedStorageUrls = [];

        const mockDb = {
            media: {
                findById: async (id) => ({ id, url: `https://storage.cdn/${id}.png` }),
                deleteById: async (id) => { deletedMediaIds.push(id); return true; },
                findByWorkflow: async (wid) => (wid === wfA ? [] : [{ id: mediaId }]),
            },
            workflows: {
                findById: async (wid) => ({ id: wid, user_id: "user-1" }),
            },
            workflowMedia: repo,
        };

        const storageService = {
            deleteByUrl: async (url) => { deletedStorageUrls.push(url); },
        };
        const authService = {
            verifyMediaOwnership: async () => true,
            verifyWorkflowOwnership: async () => true,
        };

        const service = new WorkflowMediaService({ db: mockDb, storageService, authService, mediaUploadService: { discard: async () => ({}) } });

        const result = await service.deleteMedia({
            mediaId,
            workflowId: wfA,
            userId: "user-1",
        });

        // Relation to wfA unlinked
        assert.equal(await repo.isMediaLinkedToWorkflow({ workflowId: wfA, mediaId }), false);

        // Relation to wfB STILL INTACT
        assert.equal(await repo.isMediaLinkedToWorkflow({ workflowId: wfB, mediaId }), true);
        assert.equal(await repo.countLinksForMedia(mediaId), 1);

        // Media row and storage MUST NOT be deleted
        assert.deepEqual(deletedMediaIds, [], "Media row must remain intact while linked to workflow B");
        assert.deepEqual(deletedStorageUrls, [], "Storage must remain intact while linked to workflow B");
        assert.equal(result.deleted, false, "result.deleted should be false when media is preserved");
    });

    // ─── assertOwns('element') Hardening ─────────────────────────────────────

    it("assertOwns('element'): resolves ownership when db.workflows only provides findById and user_id matches", async () => {
        const mockDb = {
            elements: {
                resolveRecord: async (id) => (id === "elem-123" ? { id: "elem-123", workflow_id: "wf-123" } : null),
            },
            workflows: {
                // ONLY findById is defined, NOT getWorkflow — ensures our new fallback works
                findById: async (id) => (id === "wf-123" ? { id: "wf-123", user_id: "owner-user" } : null),
            },
            projects: {
                findByUser: async () => [],
            },
        };

        // Inject mock db into the ownership module so the test stays hermetic
        setDb(mockDb);
        try {
            const resource = await assertOwns("element", "elem-123", "owner-user");
            assert.equal(resource.id, "elem-123");
        } finally {
            // Always restore so other tests are unaffected
            setDb(null);
        }
    });
});
}

// ─── Source: unifiedSharedMediaProtocolBoundary.test.js ───
{
/**
 * Boundary Tests: Unified Shared-Media Protocol & Atomic Orphan Reaping
 *
 * Verifies that ALL orphan-reaping paths (WorkflowMediaService.releaseWorkflowMedia,
 * ElementMediaService.removeReferenceMedia, CharacterMediaService.removeDetailMedia)
 * route through the atomic `unlinkAndReapOrphan` protocol, and that Character
 * existing-media attachment paths participate in atomic attach without element quota.
 *
 * NOTE: These tests verify JS control flow and repository contract semantics hermetically.
 * Real PostgreSQL multi-connection lock ordering is labeled UNVERIFIED at runtime.
 */


describe("Unified Shared-Media Orphan Reaping & Attach Protocol", () => {

  it("ORPHAN-1: WorkflowMediaService.releaseWorkflowMedia calls unlinkAndReapOrphan per media and preserves shared storage", async () => {
    const unlinkedCalls = [];
    const deletedStorage = [];

    const mockDb = {
      media: {
        findByWorkflow: async (wfId) => [
          { id: "m-exclusive", url: "https://storage.local/exclusive.png" },
          { id: "m-shared", url: "https://storage.local/shared.png" },
        ],
      },
      workflowMedia: {
        unlinkAndReapOrphan: async ({ workflowId, mediaId }) => {
          unlinkedCalls.push({ workflowId, mediaId });
          if (mediaId === "m-exclusive") {
            return { unlinked: true, is_orphan: true, storage_url: "https://storage.local/exclusive.png", remaining_links: 0 };
          }
          // m-shared is still linked to another workflow
          return { unlinked: true, is_orphan: false, storage_url: null, remaining_links: 1 };
        },
        unlinkByWorkflow: async () => {},
        findByMedia: async () => [],
      },
      workflows: {
        updatePrimaryMedia: async () => {},
      },
    };

    const mockStorage = {
      deleteByUrl: async (url) => {
        deletedStorage.push(url);
      },
    };

    const service = new WorkflowMediaService({
      db: mockDb,
      storageService: mockStorage,
      authService: { verifyWorkflowOwnership: async () => true },
      mediaUploadService: { discard: async () => ({}) },
    });

    const res = await service.releaseWorkflowMedia({ workflowId: "wf-1" });

    assert.equal(unlinkedCalls.length, 2, "Must call unlinkAndReapOrphan for each linked media item");
    assert.ok(unlinkedCalls.some((c) => c.mediaId === "m-exclusive"));
    assert.ok(unlinkedCalls.some((c) => c.mediaId === "m-shared"));
    assert.deepEqual(res.deletedOrphanIds, ["m-exclusive"], "Only true orphan must be reaped");
    assert.deepEqual(deletedStorage, ["https://storage.local/exclusive.png"], "Shared storage must NOT be deleted");
  });

  it("ORPHAN-2: ElementMediaService.removeReferenceMedia uses unlinkAndReapOrphan and preserves shared storage", async () => {
    let unlinkReapCalled = null;
    const deletedStorage = [];

    const mockDb = {
      elements: {
        resolveRecord: async () => ({ id: "elem-1", workflow_id: "wf-elem-1" }),
      },
      workflowMedia: {
        getPrimaryMedia: async () => null,
        unlinkAndReapOrphan: async (params) => {
          unlinkReapCalled = params;
          // Simulate shared asset: remaining_links = 1
          return { unlinked: true, is_orphan: false, storage_url: null, remaining_links: 1 };
        },
      },
      media: {
        findById: async () => ({ id: "media-shared-elem", url: "https://storage.local/elem-shared.png" }),
      },
    };

    const mockStorage = {
      deleteByUrl: async (url) => {
        deletedStorage.push(url);
      },
    };

    const service = new ElementMediaService({
      db: mockDb,
      storageService: mockStorage,
      mediaUploadService: { upload: async () => ({ files: [] }), discard: async () => ({}) },
      workflowMediaService: { attachMediaItems: async () => ({}) },
      authService: { verifyWorkflowOwnership: async () => true },
    });

    const res = await service.removeReferenceMedia({
      elementId: "elem-1",
      mediaId: "media-shared-elem",
      userId: "user-1",
    });

    assert.ok(unlinkReapCalled, "unlinkAndReapOrphan must be invoked");
    assert.equal(unlinkReapCalled.workflowId, "wf-elem-1");
    assert.equal(unlinkReapCalled.mediaId, "media-shared-elem");
    assert.equal(deletedStorage.length, 0, "Storage must NOT be deleted for shared asset");
    assert.equal(res.ok, true);
  });

  it("ORPHAN-3: CharacterMediaService.removeDetailMedia uses unlinkAndReapOrphan and deletes storage only on true orphan", async () => {
    let unlinkReapCalled = null;
    const deletedStorage = [];

    const mockDb = {
      workflows: {
        getWorkflow: async () => ({ id: "char-wf-1" }),
      },
      workflowMedia: {
        findByMedia: async () => [{ workflow_id: "char-wf-1", role: "detail" }],
        getPrimaryMedia: async () => null,
        unlinkAndReapOrphan: async (params) => {
          unlinkReapCalled = params;
          // True orphan: remaining_links = 0
          return { unlinked: true, is_orphan: true, storage_url: "https://storage.local/char-detail.png", remaining_links: 0 };
        },
      },
      media: {
        findById: async () => ({ id: "m-char-1", role: "detail", url: "https://storage.local/char-detail.png" }),
      },
    };

    const mockStorage = {
      deleteByUrl: async (url) => {
        deletedStorage.push(url);
      },
    };

    const service = new CharacterMediaService({
      db: mockDb,
      storageService: mockStorage,
      mediaUploadService: { upload: async () => ({}), discard: async () => ({}) },
      workflowMediaService: { attachMediaItems: async () => ({}) },
      authService: { verifyWorkflowOwnership: async () => true },
    });

    const res = await service.removeDetailMedia({
      characterId: "char-wf-1",
      mediaId: "m-char-1",
      userId: "user-1",
    });

    assert.ok(unlinkReapCalled, "unlinkAndReapOrphan must be invoked");
    assert.equal(unlinkReapCalled.workflowId, "char-wf-1");
    assert.equal(unlinkReapCalled.mediaId, "m-char-1");
    assert.equal(unlinkReapCalled.role, "detail");
    assert.deepEqual(deletedStorage, ["https://storage.local/char-detail.png"], "Storage must be deleted for true orphan");
    assert.equal(res.ok, true);
  });

  it("ATTACH-GENERIC-1: Character existing-media attach uses attachMediaItems with CHARACTER_MAX_DETAIL_MEDIA quota", async () => {
    let attachCalled = null;

    const mockWorkflowMediaService = {
      attachMediaItems: async (params) => {
        attachCalled = params;
        return { attached: [{ media: { id: "m-source-1" } }] };
      },
    };

    const mockDb = {
      workflows: {
        getWorkflow: async () => ({ id: "char-wf-attach", project_id: "p-1", user_id: "u-1" }),
      },
      workflowMedia: {
        findByWorkflow: async () => [],
      },
      media: {
        findById: async () => ({ id: "m-source-1", url: "https://storage.local/m1.png", step_id: "upload" }),
      },
    };

    const service = new CharacterMediaService({
      db: mockDb,
      storageService: {},
      mediaUploadService: { upload: async () => ({}) },
      workflowMediaService: mockWorkflowMediaService,
      authService: { verifyWorkflowOwnership: async () => true },
    });

    const res = await service.uploadDetailMedia({
      characterId: "char-wf-attach",
      mediaId: "m-source-1",
      userId: "u-1",
      projectId: "p-1",
    });

    assert.ok(attachCalled, "attachMediaItems must be invoked for existing media");
    assert.equal(attachCalled.workflowId, "char-wf-attach");
    assert.equal(attachCalled.items[0].kind, "existing");
    assert.equal(attachCalled.items[0].mediaId, "m-source-1");
    assert.equal(attachCalled.role, "detail");
    assert.equal(attachCalled.maxAllowed, 5, "Character attach must pass CHARACTER_MAX_DETAIL_MEDIA quota");
    assert.equal(res.ok, true);
  });

  it("ATTACH-GENERIC-2: WorkflowMediaRepository.attachMedia supports null quota in memory mode", async () => {
    WorkflowMediaRepository.enableTestMemoryFallback();
    WorkflowMediaRepository.clearMemory();
    const repo = new WorkflowMediaRepository();

    // Attach 10 items with maxAllowed = null (unlimited)
    for (let i = 1; i <= 10; i++) {
      const res = await repo.attachMedia({
        workflowId: "wf-unlimited",
        mediaId: `media-unlimited-${i}`,
        role: "detail",
        maxAllowed: null,
      });
      assert.ok(res, `Item ${i} should be attached`);
    }

    // Must have 10 relations
    const count = await repo.countLinksForMedia("media-unlimited-10");
    assert.equal(count, 1);
  });

  it("ATTACH-IDEMPOTENT-1: Repeated attachment preserves primary state, count accuracy, and does not duplicate", async () => {
    WorkflowMediaRepository.enableTestMemoryFallback();
    WorkflowMediaRepository.clearMemory();
    const repo = new WorkflowMediaRepository();

    // Attach item 1 (becomes primary, count 1)
    const attach1 = await repo.attachReferenceMedia({
      workflowId: "wf-idempotent",
      mediaId: "media-1",
      role: "detail",
      maxAllowed: 6,
    });
    assert.equal(attach1.is_primary, true);
    assert.equal(attach1.current_count, 1);

    // Attach item 2 (non-primary, count 2)
    const attach2 = await repo.attachReferenceMedia({
      workflowId: "wf-idempotent",
      mediaId: "media-2",
      role: "detail",
      maxAllowed: 6,
    });
    assert.equal(attach2.is_primary, false);
    assert.equal(attach2.current_count, 2);

    // Re-attach item 1 (idempotent: must keep is_primary=true, count=2, not create duplicates)
    const reattach1 = await repo.attachReferenceMedia({
      workflowId: "wf-idempotent",
      mediaId: "media-1",
      role: "detail",
      maxAllowed: 6,
    });
    assert.equal(reattach1.is_primary, true, "Existing primary must NOT be unpinned on re-attach");
    assert.equal(reattach1.current_count, 2, "current_count must remain 2 on idempotent re-attach");

    // Re-attach item 2 (idempotent: must keep is_primary=false, count=2)
    const reattach2 = await repo.attachReferenceMedia({
      workflowId: "wf-idempotent",
      mediaId: "media-2",
      role: "detail",
      maxAllowed: 6,
    });
    assert.equal(reattach2.is_primary, false, "Existing non-primary must remain false");
    assert.equal(reattach2.current_count, 2, "current_count must remain 2");

    // Verify row count in memory
    const links = await repo.findByWorkflow("wf-idempotent");
    assert.equal(links.length, 2, "Must not create duplicate rows in repository");
  });

  it("ATTACH-AUTOPRIMARY-1: WorkflowMediaRepository in-memory double sets is_primary=false when autoPrimary=false on primary-less workflow", async () => {
    WorkflowMediaRepository.enableTestMemoryFallback();
    WorkflowMediaRepository.clearMemory();
    const repo = new WorkflowMediaRepository();

    const res = await repo.attachReferenceMedia({
      workflowId: "wf-autoprimary-false",
      mediaId: "media-noprimary",
      role: "detail",
      maxAllowed: 6,
      autoPrimary: false,
    });

    assert.equal(res.is_primary, false, "Must not set is_primary when autoPrimary is false");
    const links = await repo.findByWorkflow("wf-autoprimary-false");
    assert.equal(links.length, 1);
    assert.equal(links[0].is_primary, false);
  });
});
}

// ─── Source: attachReferenceMediaFailClosedBoundary.test.js ───
{
/**
 * Boundary tests: attachReferenceMedia must fail-closed when the atomic
 * attach RPC is unavailable.  A silent linkMedia() fallback would bypass
 * the FOR KEY SHARE lock and allow attach-vs-unlink races.
 *
 * NOTE: These tests exercise JS control-flow only.  PostgreSQL locking
 * behaviour (FOR KEY SHARE vs FOR UPDATE compatibility) is NOT proven here
 * and MUST be verified against a real PostgreSQL instance.
 */


// ─── helpers ──────────────────────────────────────────────────────────────────

function makeMissingRpcClient(funcName) {
    return {
        from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
        rpc: async (name) => {
            if (name === funcName) {
                const err = new Error(`function public.${funcName}() does not exist`);
                err.code = "42883";
                return { data: null, error: err };
            }
            return { data: null, error: null };
        },
    };
}

function makePostgrestMissingFunctionClient(funcName) {
    return {
        from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
        rpc: async (name) => {
            if (name === funcName) {
                // PostgREST PGRST202 style message (no SQLSTATE)
                const err = new Error(`Could not find the function public.${funcName}(uuid, uuid, text, int4) in the schema cache`);
                err.code = null;
                return { data: null, error: err };
            }
            return { data: null, error: null };
        },
    };
}

function makeUnrelatedSchemaErrorClient(funcName) {
    return {
        from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
        rpc: async (name) => {
            if (name === funcName) {
                const err = new Error('column "nonexistent_col" of relation "workflow_media" does not exist');
                err.code = "42703"; // undefined_column — must NOT be treated as missing function
                return { data: null, error: err };
            }
            return { data: null, error: null };
        },
    };
}

function repoWithClient(client) {
    const repo = new WorkflowMediaRepository();
    repo.client = () => client;
    return repo;
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("attachReferenceMedia — fail-closed when RPC unavailable", () => {
    beforeEach(() => {
        WorkflowMediaRepository.disableTestMemoryFallback();
    });

    afterEach(() => {
        WorkflowMediaRepository.disableTestMemoryFallback();
    });

    it("ATTACH-FC-1: PostgreSQL 42883 must throw ATTACH_RPC_UNAVAILABLE, never call linkMedia", async () => {
        const linkMediaCalled = [];
        const repo = repoWithClient(makeMissingRpcClient("attach_workflow_reference_media"));
        // Spy: if linkMedia is called, capture it
        const origLink = repo.linkMedia.bind(repo);
        repo.linkMedia = async (...args) => {
            linkMediaCalled.push(args);
            return origLink(...args);
        };

        await assert.rejects(
            () => repo.attachReferenceMedia({ workflowId: "wf-1", mediaId: "m-1" }),
            (err) => {
                assert.ok(
                    err.code === "ATTACH_RPC_UNAVAILABLE" || err.statusCode === 503,
                    `Expected ATTACH_RPC_UNAVAILABLE/503, got code=${err.code} msg=${err.message}`
                );
                return true;
            }
        );
        assert.equal(linkMediaCalled.length, 0, "linkMedia must NOT be called as fallback");
    });

    it("ATTACH-FC-2: PostgREST PGRST202 message must throw ATTACH_RPC_UNAVAILABLE, never call linkMedia", async () => {
        const linkMediaCalled = [];
        const repo = repoWithClient(makePostgrestMissingFunctionClient("attach_workflow_reference_media"));
        const origLink = repo.linkMedia.bind(repo);
        repo.linkMedia = async (...args) => {
            linkMediaCalled.push(args);
            return origLink(...args);
        };

        await assert.rejects(
            () => repo.attachReferenceMedia({ workflowId: "wf-2", mediaId: "m-2" }),
            (err) => {
                assert.ok(
                    err.code === "ATTACH_RPC_UNAVAILABLE" || err.statusCode === 503,
                    `Expected ATTACH_RPC_UNAVAILABLE/503, got code=${err.code} msg=${err.message}`
                );
                return true;
            }
        );
        assert.equal(linkMediaCalled.length, 0, "linkMedia must NOT be called as fallback");
    });

    it("ATTACH-FC-3: client.rpc is absent (no rpc function) must throw ATTACH_RPC_UNAVAILABLE", async () => {
        const client = {
            from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
            // rpc deliberately omitted
        };
        const repo = repoWithClient(client);

        await assert.rejects(
            () => repo.attachReferenceMedia({ workflowId: "wf-3", mediaId: "m-3" }),
            (err) => {
                assert.ok(
                    err.code === "ATTACH_RPC_UNAVAILABLE" || err.statusCode === 503,
                    `Expected ATTACH_RPC_UNAVAILABLE/503, got code=${err.code} msg=${err.message}`
                );
                return true;
            }
        );
    });

    it("ATTACH-FC-4: unrelated schema error (42703) must propagate, not be treated as missing RPC", async () => {
        const repo = repoWithClient(makeUnrelatedSchemaErrorClient("attach_workflow_reference_media"));

        await assert.rejects(
            () => repo.attachReferenceMedia({ workflowId: "wf-4", mediaId: "m-4" }),
            (err) => {
                assert.equal(err.code, "42703", `Expected 42703 to propagate, got ${err.code}: ${err.message}`);
                return true;
            }
        );
    });

    it("ATTACH-FC-5: successful RPC response returns data without calling linkMedia", async () => {
        const linkMediaCalled = [];
        const successClient = {
            from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
            rpc: async (name, params) => {
                if (name === "attach_workflow_reference_media") {
                    return {
                        data: {
                            workflow_id: params.p_workflow_id,
                            media_id: params.p_media_id,
                            role: params.p_role,
                            is_primary: true,
                            current_count: 1,
                            max_allowed: params.p_max_allowed,
                        },
                        error: null,
                    };
                }
                return { data: null, error: null };
            },
        };
        const repo = repoWithClient(successClient);
        const origLink = repo.linkMedia.bind(repo);
        repo.linkMedia = async (...args) => {
            linkMediaCalled.push(args);
            return origLink(...args);
        };

        const result = await repo.attachReferenceMedia({ workflowId: "wf-5", mediaId: "m-5", role: "detail" });
        assert.ok(result, "Should return RPC result");
        assert.equal(result.workflow_id, "wf-5");
        assert.equal(linkMediaCalled.length, 0, "linkMedia must NOT be called on RPC success");
    });
});

describe("ElementMediaService.addReferenceMedia — uses attachReferenceMedia for existing-media attach", () => {
    /**
     * When addReferenceMedia is called with a `mediaId` (attach-existing path),
     * it must route through attachReferenceMedia, not createMediaInWorkflow/linkMedia.
     * This ensures the FOR KEY SHARE lock is acquired on the media row.
     */

    it("ATTACH-WIRE-1: attach-existing path calls attachReferenceMedia, not linkMedia", async () => {
        const { ElementMediaService } = await import("#elements/tools");

        const attachCalled = [];
        const linkCalled = [];

        const wfId = "wf-element-wire-1";
        const mediaId = "existing-media-1";
        const elementId = "00000000-0000-0000-0000-000000000099";

        const mockWorkflowMedia = {
            findByWorkflow: async () => [],
            attachReferenceMedia: async (params) => {
                attachCalled.push(params);
                return { workflow_id: wfId, media_id: mediaId, role: "detail", is_primary: true };
            },
            linkMedia: async (params) => {
                linkCalled.push(params);
                return { workflow_id: wfId, media_id: mediaId, role: "detail" };
            },
            setPrimaryMediaIfNone: async () => true,
            countLinksForMedia: async () => 1,
        };

        const mockDb = {
            elements: {
                resolveRecord: async () => ({ id: elementId, workflow_id: wfId, project_id: "proj-1" }),
            },
            workflowMedia: mockWorkflowMedia,
            media: {
                findById: async () => ({ id: mediaId, url: "https://storage.local/m.png", step_id: "upload" }),
                createMedia: async () => { throw new Error("createMedia must not be called for existing mediaId attach"); },
            },
            workflows: {
                findById: async () => ({ id: wfId, project_id: "proj-1" }),
                updatePrimaryMedia: async () => {},
            },
        };

        const service = new ElementMediaService({
            db: mockDb,
            storageService: {},
            mediaUploadService: { upload: async () => ({ files: [], uploaded: [] }), discard: async () => ({}) },
            workflowMediaService: {
                attachMediaItems: async ({ workflowId, items, role, maxAllowed }) => {
                    for (const item of items) {
                        await mockWorkflowMedia.attachReferenceMedia({
                            workflowId,
                            mediaId: item.mediaId,
                            role,
                            maxAllowed,
                        });
                    }
                    return { attached: items.map(it => ({ media: { id: it.mediaId }, is_primary: false })) };
                },
            },
            authService: { verifyWorkflowOwnership: async () => true },
        });
        // _resolveSourceMedia must return the source media
        service._resolveSourceMedia = async () => ({ id: mediaId, url: "https://storage.local/m.png", step_id: "upload" });
        service._determineShouldBePrimary = async () => false;
        service.setCoverIfNone = async () => false;

        await service.addReferenceMedia({ elementId, mediaId, userId: "user-1", projectId: "proj-1" });

        assert.ok(attachCalled.length > 0, "attachReferenceMedia must be called for the existing-media attach path");
        assert.equal(linkCalled.length, 0, "linkMedia must NOT be called directly by addReferenceMedia");
        assert.equal(attachCalled[0].mediaId, mediaId);
        assert.equal(attachCalled[0].workflowId, wfId);
    });

    it("ATTACH-WIRE-2: attach-existing path with RPC unavailable fails with 503, not a silent link", async () => {
        const { ElementMediaService } = await import("#elements/tools");

        const wfId = "wf-element-wire-2";
        const mediaId = "existing-media-2";
        const elementId = "00000000-0000-0000-0000-000000000098";

        const mockWorkflowMedia = {
            findByWorkflow: async () => [],
            attachReferenceMedia: async () => {
                const err = new Error("Atomic attach RPC unavailable");
                err.code = "ATTACH_RPC_UNAVAILABLE";
                err.statusCode = 503;
                throw err;
            },
            linkMedia: async () => {
                throw new Error("linkMedia must NOT be called when attachReferenceMedia fails closed");
            },
        };

        const mockDb = {
            elements: {
                resolveRecord: async () => ({ id: elementId, workflow_id: wfId, project_id: "proj-1" }),
            },
            workflowMedia: mockWorkflowMedia,
            media: { findById: async () => ({ id: mediaId, url: "https://storage.local/m.png", step_id: "upload" }) },
            workflows: { findById: async () => ({ id: wfId }), updatePrimaryMedia: async () => {} },
        };

        const service = new ElementMediaService({
            db: mockDb,
            storageService: {},
            mediaUploadService: { upload: async () => ({ files: [], uploaded: [] }), discard: async () => ({}) },
            workflowMediaService: {
                attachMediaItems: async ({ workflowId, items, role, maxAllowed }) => {
                    return await mockWorkflowMedia.attachReferenceMedia({
                        workflowId,
                        mediaId: items[0].mediaId,
                        role,
                        maxAllowed,
                    });
                },
            },
            authService: { verifyWorkflowOwnership: async () => true },
        });
        service._resolveSourceMedia = async () => ({ id: mediaId, url: "https://storage.local/m.png", step_id: "upload" });
        service._determineShouldBePrimary = async () => false;
        service.setCoverIfNone = async () => false;

        await assert.rejects(
            () => service.addReferenceMedia({ elementId, mediaId, userId: "user-1", projectId: "proj-1" }),
            (err) => {
                assert.ok(
                    err.statusCode === 503 || err.code === "ATTACH_RPC_UNAVAILABLE" || err.errorCode === "SERVICE_UNAVAILABLE",
                    `Expected 503/ATTACH_RPC_UNAVAILABLE, got ${err.code}: ${err.message}`
                );
                return true;
            }
        );
    });
});
}

describe("WorkflowMediaRepository.linkMedia — preserves existing is_primary & metadata when is_primary is omitted", () => {
    it("in memory mode: calling linkMedia without is_primary/isPrimary preserves existing is_primary: true and metadata", async () => {
        WorkflowMediaRepository.enableTestMemoryFallback();
        const repo = new WorkflowMediaRepository();
        const wfId = "wf-linkmedia-preserve-mem-1";
        const mediaId = "media-linkmedia-preserve-mem-1";

        const initial = await repo.linkMedia({
            workflowId: wfId,
            mediaId,
            role: "output",
            is_primary: true,
            metadata: { edit_type: "relight", source: "primary" },
        });
        assert.equal(initial.is_primary, true);
        assert.deepEqual(initial.metadata, { edit_type: "relight", source: "primary" });

        // Re-link without specifying is_primary / isPrimary / metadata (e.g. from SaveMedia / completeMedia)
        const relinked = await repo.linkMedia({
            workflowId: wfId,
            mediaId,
            role: "output",
        });

        assert.equal(relinked.is_primary, true, "existing is_primary: true must NOT be clobbered to false");
        assert.deepEqual(
            relinked.metadata,
            { edit_type: "relight", source: "primary" },
            "existing metadata must NOT be clobbered to {}"
        );

        const primary = await repo.getPrimaryMedia(wfId);
        assert.equal(primary?.media_id, mediaId);
        assert.equal(primary?.is_primary, true);
    });

    it("in Supabase client mode: calling linkMedia without is_primary uses ignoreDuplicates: true and returns existing row intact", async () => {
        const repo = new WorkflowMediaRepository();
        const wfId = "wf-linkmedia-preserve-sb-1";
        const mediaId = "media-linkmedia-preserve-sb-1";
        const existingRow = {
            workflow_id: wfId,
            media_id: mediaId,
            role: "output",
            is_primary: true,
            metadata: { edit_type: "angles" },
        };

        let capturedUpsertOpts = null;
        let fetchedExisting = false;

        const mockClient = {
            from: () => ({
                upsert: (_payload, opts) => {
                    capturedUpsertOpts = opts;
                    return {
                        select: () => ({
                            maybeSingle: async () => ({ data: null, error: null }),
                        }),
                    };
                },
                select: () => {
                    const chain = {
                        eq: () => chain,
                        maybeSingle: async () => {
                            fetchedExisting = true;
                            return { data: existingRow, error: null };
                        },
                    };
                    return chain;
                },
            }),
        };

        repo._isMemoryMode = () => false;
        repo._getClientOrThrow = () => mockClient;

        const result = await repo.linkMedia({
            workflowId: wfId,
            mediaId,
            role: "output",
        });

        assert.deepEqual(capturedUpsertOpts, {
            onConflict: "workflow_id,media_id,role",
            ignoreDuplicates: true,
        });
        assert.equal(fetchedExisting, true, "must fetch existing row when ignoreDuplicates skips duplicate insert");
        assert.equal(result.is_primary, true);
        assert.deepEqual(result.metadata, { edit_type: "angles" });
    });
});
