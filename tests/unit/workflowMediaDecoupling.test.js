import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CharacterMediaService } from "#characters/tools";
import { ElementMediaService } from "#elements/tools";
import { ProjectReadService } from "#workspace/tools";

describe("ADR-0008 Decoupling media.step_id (provenance) from workflow_media.role (domain relationship)", () => {
  it("CharacterMediaService: linking existing media preserves technical step_id and sets role: 'sheet'", async () => {
    let linkedRole = null;
    let linkedStepId = null;
    const existingMedia = {
      id: "media-gen-123",
      step_id: "image_generation",
      url: "https://example.com/character.png",
      user_id: "user-1",
      project_id: "proj-1",
    };

    const service = new CharacterMediaService({
      mediaUploadService: { upload: async () => ({ uploaded: [] }), discard: async () => ({}) },
      workflowMediaService: {
        attachMediaItems: async ({ workflowId, items, role = "sheet" }) => {
          linkedRole = role;
          linkedStepId = existingMedia.step_id;
          return {
            attached: [{
              media: existingMedia,
              link: { workflow_id: workflowId, media_id: existingMedia.id, role },
              is_primary: true,
            }],
          };
        },
      },
      authService: { verifyWorkflowOwnership: async () => true },
      db: {
        workflows: {
          getWorkflow: async () => ({ id: "char-wf-1", user_id: "user-1", project_id: "proj-1", workflow_type: "CHARACTER" }),
          updatePrimaryMedia: async () => ({}),
        },
        characters: {
          updateCharacterFields: async () => ({}),
        },
        media: {
          findById: async () => existingMedia,
        },
        workflowMedia: {
          findByWorkflow: async () => [],
          findByMedia: async () => [{ workflow_id: "source-wf-1", role: "output" }],
          linkMedia: async (opts) => {
            linkedRole = opts.role;
            linkedStepId = opts.stepId;
            return { ...opts, ok: true };
          },
        },
      },
      storageService: {},
    });

    const res = await service.uploadSheetMedia({
      characterId: "char-wf-1",
      mediaId: "media-gen-123",
      userId: "user-1",
      projectId: "proj-1",
    });

    assert.equal(res.ok, true);
    assert.equal(res.media.step_id, "image_generation", "Must preserve authentic technical step_id provenance");
    assert.notEqual(res.media.step_id, "character_sheet", "Must NEVER write domain role into media.step_id");
    assert.equal(res.media.role, "sheet", "Must set canonical relation role to 'sheet'");
    assert.equal(linkedRole, "sheet", "Workflow relation role must be 'sheet'");
    assert.notEqual(linkedStepId, "character_sheet", "Workflow relation must not receive 'character_sheet' as stepId");
  });

  it("CharacterMediaService: creating new sheet upload sets step_id = 'upload' and role = 'sheet'", async () => {
    let createdMediaRow = null;
    let linkedRole = null;

    const service = new CharacterMediaService({
      mediaUploadService: {
        upload: async ({ files }) => ({
          uploaded: [{ id: "new-media-1", url: "https://cdn.example.com/new.png", step_id: "upload" }],
        }),
        discard: async () => ({}),
      },
      workflowMediaService: {
        attachMediaItems: async ({ workflowId, items, role = "sheet" }) => {
          linkedRole = role;
          createdMediaRow = { id: "new-media-1", step_id: "upload", url: "https://cdn.example.com/new.png" };
          return {
            attached: [{
              media: createdMediaRow,
              link: { workflow_id: workflowId, media_id: createdMediaRow.id, role },
              is_primary: true,
            }],
          };
        },
      },
      authService: { verifyWorkflowOwnership: async () => true },
      db: {
        workflows: {
          getWorkflow: async () => ({ id: "char-wf-2", user_id: "user-1", project_id: "proj-1", workflow_type: "CHARACTER" }),
          updatePrimaryMedia: async () => ({}),
        },
        characters: {
          updateCharacterFields: async () => ({}),
        },
        media: {
          findByWorkflow: async () => [],
          createMedia: async (data) => {
            createdMediaRow = { id: "new-media-1", ...data };
            return createdMediaRow;
          },
        },
        workflowMedia: {
          findByWorkflow: async () => [],
          linkMedia: async (opts) => {
            linkedRole = opts.role;
            return { ...opts, ok: true };
          },
        },
      },
      storageService: {
        paths: { characterSheet: () => "sheets/new.png" },
        upload: async () => "https://cdn.example.com/new.png",
      },
    });

    const res = await service.uploadSheetMedia({
      characterId: "char-wf-2",
      imageUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      userId: "user-1",
      projectId: "proj-1",
    });

    assert.equal(res.ok, true);
    assert.equal(createdMediaRow.step_id, "upload", "New media upload technical provenance must be 'upload'");
    assert.notEqual(createdMediaRow.step_id, "character_sheet", "Must NEVER write 'character_sheet' into media.step_id");
    assert.equal(linkedRole, "sheet", "workflow_media relation must have role = 'sheet'");
  });

  it("CharacterMediaService: attaching detail media sets step_id = 'upload' and role = 'detail'", async () => {
    let createdMediaRow = null;
    let linkedRole = null;

    const service = new CharacterMediaService({
      mediaUploadService: {
        upload: async ({ files }) => ({
          uploaded: [{ id: "detail-media-1", url: "https://cdn.example.com/detail.png", step_id: "upload" }],
        }),
        discard: async () => ({}),
      },
      workflowMediaService: {
        attachMediaItems: async ({ workflowId, items, role = "detail" }) => {
          linkedRole = role;
          createdMediaRow = { id: "detail-media-1", step_id: "upload", url: "https://cdn.example.com/detail.png" };
          return {
            attached: [{
              media: createdMediaRow,
              link: { workflow_id: workflowId, media_id: createdMediaRow.id, role },
              is_primary: false,
            }],
          };
        },
      },
      authService: { verifyWorkflowOwnership: async () => true },
      db: {
        workflows: {
          getWorkflow: async () => ({ id: "char-wf-3", user_id: "user-1", project_id: "proj-1", workflow_type: "CHARACTER" }),
        },
        media: {
          createMedia: async (data) => {
            createdMediaRow = { id: "detail-media-1", ...data };
            return createdMediaRow;
          },
        },
        workflowMedia: {
          findByWorkflow: async () => [],
          linkMedia: async (opts) => {
            linkedRole = opts.role;
            return { ...opts, ok: true };
          },
        },
      },
      storageService: {
        paths: { characterDetail: () => "details/new.png" },
        upload: async () => "https://cdn.example.com/detail.png",
      },
    });

    const res = await service.uploadDetailMedia({
      characterId: "char-wf-3",
      imageUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      userId: "user-1",
      projectId: "proj-1",
    });

    assert.equal(res.ok, true);
    assert.equal(createdMediaRow.step_id, "upload", "Detail media upload provenance must be 'upload'");
    assert.notEqual(createdMediaRow.step_id, "character_detail", "Must NEVER write 'character_detail' into media.step_id");
    assert.equal(linkedRole, "detail", "workflow_media relation role must be 'detail'");
  });

  it("ElementMediaService: ingestElementSources sets step_id = 'upload' and canonical roles 'sheet' and 'detail'", async () => {
    const createdMediaRows = [];
    const linkedRelations = [];

    const service = new ElementMediaService({
      storageService: {},
      mediaUploadService: {
        upload: async ({ files }) => ({
          uploaded: files.map((f, i) => ({ id: "elem-media-" + (createdMediaRows.length + i + 1), url: f, step_id: "upload" })),
        }),
        discard: async () => ({}),
      },
      workflowMediaService: {
        attachMediaItems: async ({ workflowId, items, role = "detail" }) => {
          const attached = [];
          for (const item of items) {
            const m = item.uploadedFile;
            createdMediaRows.push(m);
            const link = { workflow_id: workflowId, media_id: m.id, role };
            linkedRelations.push(link);
            attached.push({ media: m, link, is_primary: true });
          }
          return { attached };
        },
      },
      authService: {
        verifyWorkflowOwnership: async () => true,
      },
      db: {
        media: {
          createMedia: async (data) => {
            const row = { id: `elem-media-${createdMediaRows.length + 1}`, ...data };
            createdMediaRows.push(row);
            return row;
          },
        },
        workflows: {
          updatePrimaryMedia: async () => ({}),
        },
        workflowMedia: {
          linkMedia: async (opts) => {
            linkedRelations.push(opts);
            return { ...opts, ok: true };
          },
        },
      },
      storageService: {},
    });

    await service.ingestElementSources({
      workflowId: "elem-wf-1",
      sourceImages: ["https://cdn.example.com/img1.png", "https://cdn.example.com/img2.png"],
      projectId: "proj-1",
      userId: "user-1",
    });

    assert.equal(createdMediaRows.length, 2);
    assert.equal(createdMediaRows[0].step_id, "upload", "Primary source media provenance must be 'upload'");
    assert.notEqual(createdMediaRows[0].step_id, "element_sheet", "Must NEVER write 'element_sheet' into media.step_id");
    assert.equal(createdMediaRows[1].step_id, "upload", "Secondary source media provenance must be 'upload'");
    assert.notEqual(createdMediaRows[1].step_id, "element_reference", "Must NEVER write 'element_reference' into media.step_id");

    assert.equal(linkedRelations.length, 2);
    assert.equal(linkedRelations[0].role, "detail", "First image relation must have role = 'detail'");
    assert.equal(linkedRelations[1].role, "detail", "Subsequent image relation must have role = 'detail'");
  });

  it("ProjectReadService: secondary workflow media retains original step_id and returns canonical role", async () => {
    const projectId = "11111111-1111-4111-8111-111111111111";
    const userId = "22222222-2222-4222-8222-222222222222";
    const { supabase, supabaseAdmin } = await import("#shared/db/supabase.js");

    const origFrom = supabase.from;
    const origAdminFrom = supabaseAdmin.from;

    supabase.from = (table) => {
      if (table === "project") {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: projectId, user_id: userId, project_name: "Test Project" },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "media") {
        return {
          select: () => ({
            eq: () => ({
              order: async () => ({
                data: [
                  {
                    id: "media-orig-1",
                    project_id: projectId,
                    url: "https://example.com/gen.png",
                    step_id: "image_generation",
                    status: "success",
                    width: 1024,
                    height: 1024,
                    create_time: new Date().toISOString(),
                  },
                ],
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "workflow_media") {
        return {
          select: () => ({
            in: async () => ({
              data: [
                { workflow_id: "wf-primary", media_id: "media-orig-1", role: "output", is_primary: true },
                { workflow_id: "wf-char", media_id: "media-orig-1", role: "detail", is_primary: false },
              ],
              error: null,
            }),
          }),
        };
      }
      if (table === "element" || table === "folders" || table === "generation_config") {
        return {
          select: () => ({
            in: async () => ({ data: [], error: null }),
            eq: async () => ({ data: [], error: null }),
          }),
        };
      }
      return origFrom.call(supabase, table);
    };

    supabaseAdmin.from = (table) => {
      if (table === "characters") {
        return {
          select: () => ({
            or: async () => ({ data: [], error: null }),
            eq: async () => ({ data: [], error: null }),
          }),
        };
      }
      return origAdminFrom.call(supabaseAdmin, table);
    };

    try {
      const mockDb = {
        workflows: {
          findByProject: async () => [
            { id: "wf-primary", display_name: "Original Asset", workflow_type: "GENERATION", project_id: projectId, primary_media_id: "media-orig-1" },
            { id: "wf-char", display_name: "Hero Character", workflow_type: "CHARACTER", project_id: projectId },
          ],
        },
      };

      const service = new ProjectReadService({ db: mockDb });
      const res = await service.getProjectData({ projectId, userId });

      const charWf = res.workflows.find((w) => w.id === "wf-char");
      assert.ok(charWf, "Character workflow must be present");
      assert.equal(charWf.items.length, 1);

      const linkedItem = charWf.items[0];
      assert.equal(linkedItem.role, "detail", "Canonical relation role must be 'detail'");
      assert.equal(linkedItem.mediaRole, "detail", "mediaRole must be 'detail'");
      assert.equal(linkedItem.step_id, "image_generation", "Must retain authentic provenance 'image_generation'");
      assert.notEqual(linkedItem.step_id, "character_detail", "Must NOT synthesize 'character_detail' into step_id");
      assert.notEqual(linkedItem.workflowStepId, "character_detail", "Must NOT synthesize 'character_detail' into workflowStepId");
    } finally {
      supabase.from = origFrom;
      supabaseAdmin.from = origAdminFrom;
    }
  });
});
