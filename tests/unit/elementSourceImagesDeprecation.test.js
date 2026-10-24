import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ElementRepository } from "../../src/db/ElementRepository.js";
import { ElementMediaService } from "../../src/domain/element/ElementMediaService.js";
import { ElementService } from "../../src/domain/element/ElementService.js";
import { resolveAsElement } from "../../src/v2/resolvers/WorkflowReferenceResolver.js";

const VALID_ELEMENT_ID = "11111111-1111-4111-8111-111111111111";
const VALID_WORKFLOW_ID = "22222222-2222-4222-8222-222222222222";
const VALID_MEDIA_ID = "33333333-3333-4333-8333-333333333333";

describe("ADR-0009: element.source_images deprecation & decoupling", () => {

  describe("1. ElementRepository", () => {
    it("create() does NOT pass source_images in the insert payload", async () => {
      let insertPayload = null;
      const repo = new ElementRepository();

      const { supabase } = await import("../../lib/supabase.js");
      const originalFrom = supabase.from;

      try {
        supabase.from = (table) => {
          assert.equal(table, "element");
          return {
            insert: (payload) => {
              insertPayload = payload;
              return {
                select: () => ({
                  single: async () => ({
                    data: { id: VALID_ELEMENT_ID, ...payload },
                    error: null,
                  }),
                }),
              };
            },
          };
        };

        await repo.create({
          name: "Test Element",
          workflow_id: VALID_WORKFLOW_ID,
          source_images: ["media-1", "media-2"],
        });

        assert.ok(insertPayload, "insertPayload must be captured");
        assert.equal(insertPayload.name, "Test Element");
        assert.equal(insertPayload.source_images, undefined, "source_images must NOT exist on insert payload");
      } finally {
        supabase.from = originalFrom;
      }
    });

    it("update() does NOT allow source_images in update patch", async () => {
      let updatePayload = null;
      const repo = new ElementRepository();
      const { supabase } = await import("../../lib/supabase.js");
      const originalFrom = supabase.from;

      try {
        supabase.from = (table) => {
          assert.equal(table, "element");
          return {
            update: (payload) => {
              updatePayload = payload;
              return {
                or: () => ({
                  select: async () => ({
                    data: [{ id: VALID_ELEMENT_ID, ...payload }],
                    error: null,
                  }),
                }),
                eq: () => ({
                  select: async () => ({
                    data: [{ id: VALID_ELEMENT_ID, ...payload }],
                    error: null,
                  }),
                }),
              };
            },
          };
        };

        await repo.update(VALID_ELEMENT_ID, {
          name: "Updated Element",
          source_images: ["should-be-ignored"],
        });

        assert.ok(updatePayload, "updatePayload must be captured");
        assert.equal(updatePayload.name, "Updated Element");
        assert.equal(updatePayload.source_images, undefined, "source_images must NOT be present in patch");
      } finally {
        supabase.from = originalFrom;
      }
    });
  });

  describe("2. ElementMediaService", () => {
    it("addReferenceMedia does NOT write source_images to element table", async () => {
      const elementUpdateCalls = [];
      const linkMediaCalls = [];

      const mockDb = {
        elements: {
          resolveRecord: async (id) => ({
            id: VALID_ELEMENT_ID,
            workflow_id: VALID_WORKFLOW_ID,
            project_id: "proj-1",
            source_images: ["legacy-id"],
          }),
          update: async (id, patch) => {
            elementUpdateCalls.push({ id, patch });
            return { id, ...patch };
          },
        },
        workflows: {
          getWorkflow: async (id) => ({ id: VALID_WORKFLOW_ID, project_id: "proj-1", user_id: "user-1", workflow_type: "ELEMENT" }),
          updatePrimaryMedia: async () => ({}),
        },
        workflowMedia: {
          linkMedia: async (payload) => {
            linkMediaCalls.push(payload);
            return payload;
          },
        },
        media: {
          findById: async (id) => ({ id, url: "https://example.com/media.png", step_id: "upload" }),
          createMedia: async (payload) => ({ id: VALID_MEDIA_ID, ...payload }),
        },
      };

      const service = createDeprecationTestService(mockDb);

      await service.addReferenceMedia({
        elementId: VALID_ELEMENT_ID,
        mediaId: VALID_MEDIA_ID,
        projectId: "proj-1",
        userId: "user-1",
      });

      assert.equal(linkMediaCalls.length, 1, "Must link to workflow_media");
      assert.equal(linkMediaCalls[0].role, "detail");

      // Verify no update to element.source_images was attempted
      const sourceImageUpdates = elementUpdateCalls.filter((c) => "source_images" in c.patch);
      assert.equal(sourceImageUpdates.length, 0, "Must NEVER update element.source_images");
    });

    it("removeReferenceMedia unlinks workflow_media and does NOT update element.source_images", async () => {
      const elementUpdateCalls = [];
      const unlinkCalls = [];

      const mockDb = {
        elements: {
          resolveRecord: async (id) => ({
            id: VALID_ELEMENT_ID,
            workflow_id: VALID_WORKFLOW_ID,
            project_id: "proj-1",
            source_images: [VALID_MEDIA_ID],
          }),
          update: async (id, patch) => {
            elementUpdateCalls.push({ id, patch });
            return { id, ...patch };
          },
        },
        workflows: {
          getWorkflow: async (id) => ({ id: VALID_WORKFLOW_ID, project_id: "proj-1", user_id: "user-1" }),
          findById: async () => ({ id: VALID_WORKFLOW_ID }),
          updatePrimaryMedia: async () => ({}),
        },
        workflowMedia: {
          countByMediaId: async () => 1,
          unlink: async (payload) => {
            unlinkCalls.push(payload);
            return 1;
          },
        },
        media: {
          findById: async (id) => ({ id, url: "https://example.com/img.png" }),
          deleteById: async () => {},
        },
      };

      const service = createDeprecationTestService(mockDb);

      const result = await service.removeReferenceMedia({
        elementId: VALID_ELEMENT_ID,
        mediaId: VALID_MEDIA_ID,
        projectId: "proj-1",
        userId: "user-1",
      });

      assert.equal(result.ok, true);
      assert.equal(unlinkCalls.length, 1);
      assert.equal(unlinkCalls[0].workflowId, VALID_WORKFLOW_ID);
      assert.equal(unlinkCalls[0].mediaId, VALID_MEDIA_ID);

      const sourceImageUpdates = elementUpdateCalls.filter((c) => "source_images" in c.patch);
      assert.equal(sourceImageUpdates.length, 0, "Must NEVER update element.source_images on delete");
    });
  });

  describe("3. ElementService", () => {
    it("createElement creates element record without passing source_images to repository", async () => {
      let createdPayload = null;

      const mockDb = {
        workflows: {
          createWorkflow: async (payload) => ({ id: VALID_WORKFLOW_ID, ...payload }),
          updatePrimaryMedia: async () => ({}),
        },
        elements: {
          create: async (payload) => {
            createdPayload = payload;
            return { id: VALID_ELEMENT_ID, ...payload };
          },
        },
        media: {
          createMedia: async (p) => ({ id: "m-new", ...p }),
        },
        workflowMedia: {
          linkMedia: async () => ({}),
        },
      };

      const mockElementMediaService = {
        ingestElementSources: async () => ({
          mediaRecords: [
            { id: "m-1", url: "https://cdn.example.com/1.png" },
            { id: "m-2", url: "https://cdn.example.com/2.png" },
          ],
          primaryMedia: { id: "m-1", url: "https://cdn.example.com/1.png" },
          storageUrls: ["https://cdn.example.com/1.png", "https://cdn.example.com/2.png"],
        }),
      };

      const service = new ElementService({
        db: mockDb,
        elementMediaService: mockElementMediaService,
        analysisService: null,
      });

      const res = await service.createElement({
        name: "Magic Wand",
        sourceImages: ["https://example.com/w1.png", "https://example.com/w2.png"],
        projectId: "proj-1",
        userId: "user-1",
      });

      assert.ok(createdPayload);
      assert.equal(createdPayload.name, "Magic Wand");
      assert.equal(createdPayload.source_images, undefined, "ElementService must NOT pass source_images to db.elements.create");
      assert.equal(res.element.source_images_count, 2, "source_images_count is returned from mediaRecords");
    });

    it("listProjectElements derives source_images_count from workflow_media without reading el.source_images", async () => {
      const mockDb = {
        elements: {
          list: async () => [
            {
              id: VALID_ELEMENT_ID,
              name: "Sword",
              workflow_id: VALID_WORKFLOW_ID,
              create_time: "2026-01-01T00:00:00Z",
              // el.source_images is intentionally absent
            },
          ],
        },
        workflows: {
          getPrimaryMediaUrl: async () => "https://cdn.example.com/cover.png",
        },
        workflowMedia: {
          findByWorkflowIds: async (ids) => [
            { workflow_id: VALID_WORKFLOW_ID, media_id: "m-1", role: "detail" },
            { workflow_id: VALID_WORKFLOW_ID, media_id: "m-2", role: "detail" },
            { workflow_id: VALID_WORKFLOW_ID, media_id: "m-3", role: "output" }, // output should not count
          ],
        },
      };

      const service = new ElementService({ db: mockDb });

      const list = await service.listProjectElements("proj-1");
      assert.equal(list.length, 1);
      assert.equal(list[0].id, VALID_ELEMENT_ID);
      assert.equal(list[0].source_images_count, 2, "Must count detail media associated with workflow");
    });
  });

  describe("4. WorkflowReferenceResolver", () => {
    it("resolveAsElement resolves reference media without reading elem.source_images", async () => {
      const { db } = await import("../../src/container.js");
      const { elementRepository } = await import("../../src/db/ElementRepository.js");

      const elemData = {
        id: VALID_ELEMENT_ID,
        workflow_id: VALID_WORKFLOW_ID,
        name: "Golden Goblet",
        description: "An ornate goblet",
        element_type: "prop",
      };

      const mediaRows = [
        { id: "m-detail-1", url: "https://example.com/detail1.png", step_id: "upload" },
        { id: "m-detail-2", url: "https://example.com/detail2.png", step_id: "upload" },
      ];

      const origFind = db.media.findByWorkflow;
      const origResolve = elementRepository.resolveRecord;

      try {
        elementRepository.resolveRecord = async () => elemData;
        db.media.findByWorkflow = async (wfId) => {
          assert.equal(wfId, VALID_WORKFLOW_ID);
          return mediaRows;
        };

        const resolved = await resolveAsElement(VALID_ELEMENT_ID);
        assert.ok(resolved);
        assert.equal(resolved.name, "Golden Goblet");
        assert.deepEqual(resolved.imageUrls.sort(), [
          "https://example.com/detail1.png",
          "https://example.com/detail2.png",
        ].sort());
      } finally {
        db.media.findByWorkflow = origFind;
        elementRepository.resolveRecord = origResolve;
      }
    });
  });

});
function createDeprecationTestService(mockDb) {
    return new ElementMediaService({
        db: mockDb,
        storageService: {},
        mediaUploadService: {
            upload: async ({ files }) => ({
                uploaded: files.map((f, idx) => ({ id: "media-dep-" + (idx + 1), url: typeof f === "string" ? f : f?.url || "https://example.com/m.png", step_id: "upload" })),
            }),
            discard: async () => ({}),
        },
        workflowMediaService: {
            attachMediaItems: async ({ workflowId, items, role = "detail" }) => {
                const attached = [];
                for (const item of items) {
                    const mId = item.kind === "existing" ? item.mediaId : item.uploadedFile?.id || "m-new";
                    if (mockDb.workflowMedia?.linkMedia) {
                        await mockDb.workflowMedia.linkMedia({ workflowId, mediaId: mId, role, is_primary: true });
                    }
                    attached.push({ media: { id: mId, url: "https://example.com/m.png" }, is_primary: true });
                }
                return { attached };
            },
        },
        authService: {
            verifyWorkflowOwnership: async () => true,
        },
    });
}


