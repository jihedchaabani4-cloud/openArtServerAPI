import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MediaRepository } from "../../src/db/MediaRepository.js";
import { WorkflowRepository } from "../../src/db/WorkflowRepository.js";

function makeQuery(result) {
  const query = {
    select() { return query; },
    eq() { return query; },
    order() { return query; },
    limit() { return query; },
    maybeSingle() { return Promise.resolve(result); },
    then(resolve, reject) { return Promise.resolve(result).then(resolve, reject); },
  };
  return query;
}

describe("workflow_media compatibility reads", () => {
  it("MediaRepository.findByWorkflow prefers workflow_media rows and preserves legacy response fields", async () => {
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
                  workflow_id: null,
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

  it("MediaRepository.findByWorkflow falls back to legacy media.workflow_id rows", async () => {
    const calls = [];
    const repo = new MediaRepository();
    repo.client = () => ({
      from(table) {
        calls.push(table);
        if (table === "workflow_media") {
          return makeQuery({ data: [], error: null });
        }
        if (table === "media") {
          return makeQuery({
            data: [{ id: "legacy-media", workflow_id: "wf-1", step_id: "image_generation" }],
            error: null,
          });
        }
        throw new Error(`unexpected table ${table}`);
      },
    });

    const rows = await repo.findByWorkflow("wf-1");

    assert.deepEqual(calls, ["workflow_media", "media"]);
    assert.deepEqual(rows, [{ id: "legacy-media", workflow_id: "wf-1", step_id: "image_generation" }]);
  });

  it("WorkflowRepository.getPrimaryMedia falls back to workflow_media before legacy media.workflow_id", async () => {
    const calls = [];
    const repo = new WorkflowRepository();
    repo.client = () => ({
      from(table) {
        calls.push(table);
        if (table === "workflow") {
          return makeQuery({ data: { primary_media_id: null }, error: null });
        }
        if (table === "workflow_media") {
          return makeQuery({
            data: {
              workflow_id: "wf-1",
              media: {
                id: "relation-media",
                url: "https://example.com/relation.png",
                generation_config_id: null,
              },
            },
            error: null,
          });
        }
        if (table === "media") {
          return makeQuery({
            data: {
              id: "legacy-media",
              url: "https://example.com/legacy.png",
              generation_config_id: null,
            },
            error: null,
          });
        }
        throw new Error(`unexpected table ${table}`);
      },
    });

    const media = await repo.getPrimaryMedia("wf-1");

    assert.equal(media.id, "relation-media");
    assert.deepEqual(calls, ["workflow", "workflow_media"]);
  });
});
