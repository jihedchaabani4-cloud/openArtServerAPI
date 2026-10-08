import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MediaService } from "../../src/platform/media/MediaService.js";

describe("MediaService workflow_media dual-write", () => {
  it("links created media to workflow_media using inferred role", async () => {
    const linkCalls = [];
    const service = new MediaService({
      db: {
        media: {
          createMedia: async (payload) => ({
            id: "media-1",
            ...payload,
          }),
        },
        workflowMedia: {
          linkMedia: async (payload) => {
            linkCalls.push(payload);
            return { workflow_id: payload.workflowId, media_id: payload.mediaId, role: "output" };
          },
        },
      },
    });

    const media = await service.createMedia({
      workflowId: "workflow-1",
      projectId: "project-1",
      stepId: "image_generation",
      url: "https://cdn.example.com/out.png",
      width: 1024,
      height: 1024,
    });

    assert.equal(media.id, "media-1");
    assert.deepEqual(linkCalls, [
      {
        workflowId: "workflow-1",
        mediaId: "media-1",
        stepId: "image_generation",
      },
    ]);
  });
});
