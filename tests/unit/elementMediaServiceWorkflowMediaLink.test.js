import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ElementMediaService } from "#elements/tools";

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

    const service = new ElementMediaService({
      db: mockDb,
      storageService: {},
      mediaUploadService: {
        upload: async ({ files }) => ({
          uploaded: [{ id: "media-ingested-1", url: "https://storage.example.com/sheet.png", storageKey: "sheet.png" }],
        }),
        discard: async () => ({}),
      },
      workflowMediaService: {
        attachMediaItems: async ({ workflowId, items, role }) => {
          for (const item of items) {
            linkCalls.push({
              workflowId,
              mediaId: item.uploadedFile.id,
              role,
            });
          }
          return {
            attached: items.map((it) => ({ media: it.uploadedFile, is_primary: true })),
          };
        },
      },
      authService: {
        verifyWorkflowOwnership: async () => true,
      },
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
