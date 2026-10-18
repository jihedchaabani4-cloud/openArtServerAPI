import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createWorkflowWithMediaAtomic, createWorkflowWithMedia } from "../../src/db/workflowMediaOps.js";
import { supabase } from "../../lib/supabase.js";

describe("createWorkflowWithMediaAtomic backend implementation (no RPC dependency)", () => {
  it("creates workflow, media placeholder, links workflow_media and sets primary media purely in backend", async () => {
    let rpcCalled = false;
    const originalRpc = supabase.rpc;
    supabase.rpc = async () => {
      rpcCalled = true;
      throw new Error("RPC should NOT be called");
    };

    const createdWorkflows = [];
    const createdMedia = [];
    const linkedMedia = [];
    const primaryUpdates = [];

    const mockDb = {
      workflows: {
        createWorkflow: async (payload) => {
          const wf = { id: "wf-backend-1", ...payload };
          createdWorkflows.push(wf);
          return wf;
        },
        updatePrimaryMedia: async (wfId, mediaId) => {
          primaryUpdates.push({ wfId, mediaId });
          return { id: wfId, primary_media_id: mediaId };
        },
      },
      media: {
        createMedia: async (payload) => {
          const m = { id: "media-backend-1", ...payload };
          createdMedia.push(m);
          return m;
        },
      },
      workflowMedia: {
        linkMedia: async (payload) => {
          linkedMedia.push(payload);
          return payload;
        },
      },
    };

    try {
      const res = await createWorkflowWithMediaAtomic(mockDb, {
        workflowData: {
          project_id: "proj-1",
          session_id: "sess-1",
          display_name: "Backend Hero",
          workflow_type: "CHARACTER",
        },
        mediaData: {
          project_id: "proj-1",
          generation_config_id: "gen-cfg-1",
          step_id: "character_sheet",
          width: 1024,
          height: 1024,
        },
      });

      assert.equal(rpcCalled, false, "createWorkflowWithMediaAtomic must execute in backend without calling supabase.rpc");
      assert.equal(res.workflow.id, "wf-backend-1");
      assert.equal(res.media.id, "media-backend-1");

      assert.equal(createdWorkflows.length, 1);
      assert.equal(createdWorkflows[0].display_name, "Backend Hero");

      assert.equal(createdMedia.length, 1);
      assert.equal(createdMedia[0].status, "processing");
      assert.equal("workflow_id" in createdMedia[0], false, "media.createMedia must not contain workflow_id");

      assert.equal(linkedMedia.length, 1);
      assert.equal(linkedMedia[0].workflowId, "wf-backend-1");
      assert.equal(linkedMedia[0].mediaId, "media-backend-1");
      assert.equal(linkedMedia[0].stepId, "character_sheet");
      assert.equal(linkedMedia[0].workflowType, "CHARACTER");

      assert.equal(primaryUpdates.length, 1);
      assert.equal(primaryUpdates[0].wfId, "wf-backend-1");
      assert.equal(primaryUpdates[0].mediaId, "media-backend-1");
    } finally {
      supabase.rpc = originalRpc;
    }
  });

  it("performs compensating rollback if linkWorkflowMedia fails, ensuring atomicity", async () => {
    let deletedWorkflowId = null;
    let deletedMediaId = null;

    const mockDb = {
      workflows: {
        createWorkflow: async (payload) => ({ id: "wf-rollback-1", ...payload }),
        deleteWorkflow: async (id) => {
          deletedWorkflowId = id;
          return true;
        },
        updatePrimaryMedia: async () => ({}),
      },
      media: {
        createMedia: async (payload) => ({ id: "m-rollback-1", ...payload }),
        deleteMedia: async (id) => {
          deletedMediaId = id;
          return true;
        },
      },
      workflowMedia: {
        linkMedia: async () => {
          throw new Error("workflowMedia link constraint failure");
        },
      },
    };

    await assert.rejects(
      async () => {
        await createWorkflowWithMediaAtomic(mockDb, {
          workflowData: { project_id: "proj-1", workflow_type: "GENERATION" },
          mediaData: { project_id: "proj-1", step_id: "image_generation" },
        });
      },
      /Failed to link media to workflow in workflow_media/
    );

    assert.equal(deletedMediaId, "m-rollback-1", "must delete partially created media");
    assert.equal(deletedWorkflowId, "wf-rollback-1", "must delete partially created workflow");
  });
});
