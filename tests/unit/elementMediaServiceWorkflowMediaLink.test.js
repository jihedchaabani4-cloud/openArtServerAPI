import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ElementMediaService } from "../../src/domain/element/ElementMediaService.js";

describe("Ticket 04: ElementMediaService workflow_media link hardening", () => {
  it("ingestElementSources always links workflow_media even when mediaIngestionService is present", async () => {
    const linkCalls = [];
    const mockDb = {
      workflows: {
        updatePrimaryMedia: async () => ({}),
      },
      workflowMedia: {
        linkMedia: async (payload) => {
          linkCalls.push(payload);
          return payload;
        },
      },
    };

    const mockIngestionService = {
      ingest: async ({ workflowId, stepId }) => ({
        media: { id: "media-ingested-1", step_id: stepId },
        url: "https://storage.example.com/sheet.png",
      }),
    };

    const service = new ElementMediaService({
      db: mockDb,
      storageService: {},
      mediaIngestionService: mockIngestionService,
    });

    await service.ingestElementSources({
      workflowId: "elem-wf-1",
      sourceImages: ["https://example.com/source.png"],
      projectId: "proj-1",
      userId: "user-1",
    });

    assert.equal(linkCalls.length, 1, "Must call linkMedia on workflowMedia");
    assert.equal(linkCalls[0].workflowId, "elem-wf-1");
    assert.equal(linkCalls[0].mediaId, "media-ingested-1");
  });
});
