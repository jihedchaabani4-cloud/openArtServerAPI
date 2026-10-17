import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MediaRepository } from "../../src/db/MediaRepository.js";
import { WorkflowRepository } from "../../src/db/WorkflowRepository.js";
import { ProjectReadService } from "../../src/domain/project/ProjectReadService.js";
import { GenerationService } from "../../src/domain/generation/GenerationService.js";
import { CharacterMediaService } from "../../src/domain/character/CharacterMediaService.js";
import { ElementMediaService } from "../../src/domain/element/ElementMediaService.js";

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

  it("WorkflowRepository.getPrimaryMedia queries workflow.primary_media_id then workflow_media ONLY (no media.workflow_id fallback)", async () => {
    const calls = [];
    const repo = new WorkflowRepository();
    repo.client = () => ({
      from(table) {
        calls.push(table);
        if (table === "workflow") {
          return makeQuery({ data: { primary_media_id: null }, error: null });
        }
        if (table === "workflow_media") {
          return makeQuery({ data: null, error: null });
        }
        throw new Error(`unexpected fallback to table ${table}`);
      },
    });

    const media = await repo.getPrimaryMedia("wf-unpinned");

    assert.equal(media, null);
    assert.deepEqual(calls, ["workflow", "workflow_media"]);
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
              variation_index: 0,
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
              variation_index: 0,
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

  it("CharacterMediaService._resolveSourceMedia and ElementMediaService._resolveSourceMedia reject unlinked media (0 workflow_media links) with 404", async () => {
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

    const charService = new CharacterMediaService({ db: mockDb, storageService: {} });
    const elemService = new ElementMediaService({ db: mockDb, storageService: {} });

    await assert.rejects(
      () => charService._resolveSourceMedia("m-orphan-1", { userId: "user-1", projectId: "proj-1" }),
      (err) => err.statusCode === 404
    );

    await assert.rejects(
      () => elemService._resolveSourceMedia("m-orphan-1", { userId: "user-1", projectId: "proj-1" }),
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
        variation_index: 0,
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
