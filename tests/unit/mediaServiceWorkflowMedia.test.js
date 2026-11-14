import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MediaService } from "#media/tools";

describe("MediaService — strict public.media ownership boundary", () => {
  it("persists canonical media rows to public.media and never writes to workflow_media", async () => {
    const mediaInserts = [];
    let workflowMediaTouched = false;
    const service = new MediaService({
      db: {
        media: {
          createMedia: async (payload) => {
            mediaInserts.push(payload);
            return {
              id: "media-1",
              ...payload,
            };
          },
        },
        workflowMedia: {
          linkMedia: async () => {
            workflowMediaTouched = true;
            throw new Error("MediaService must not write to workflow_media");
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
    assert.equal(workflowMediaTouched, false);
    assert.equal(mediaInserts.length, 1);
    assert.equal("workflow_id" in mediaInserts[0], false);
    assert.equal("workflowId" in mediaInserts[0], false);
  });
});
