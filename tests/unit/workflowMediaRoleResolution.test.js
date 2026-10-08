import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { db } from "../../src/container.js";
import { resolveAsCharacter } from "../../src/v2/resolvers/WorkflowReferenceResolver.js";
import { CharacterMediaService } from "../../src/domain/character/CharacterMediaService.js";

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

  it("resolveAsCharacter separates sheet and detail images using mediaRole before legacy step_id", async () => {
    db.characters = {
      findByCharacterId: async () => ({
        id: "char-1",
        workflow_id: "char-wf-1",
        name: "Mira",
        description: "Character description",
      }),
    };
    db.media = {
      findByWorkflow: async () => [
        {
          id: "sheet-media",
          workflow_id: "char-wf-1",
          step_id: "image_generation",
          mediaRole: "sheet",
          url: "https://cdn.example.com/sheet.png",
        },
        {
          id: "detail-media",
          workflow_id: "char-wf-1",
          step_id: "image_generation",
          mediaRole: "detail",
          url: "https://cdn.example.com/detail.png",
        },
      ],
    };

    const resolved = await resolveAsCharacter("char-1");

    assert.deepEqual(resolved.sheetImages, ["https://cdn.example.com/sheet.png"]);
    assert.deepEqual(resolved.detailImages, ["https://cdn.example.com/detail.png"]);
  });

  it("CharacterMediaService.uploadSheetMedia reuses existing sheet rows identified by role", async () => {
    let updated = null;
    let created = false;
    const service = new CharacterMediaService({
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
    });

    assert.equal(created, false);
    assert.equal(updated.id, "existing-sheet");
    assert.equal(updated.fields.step_id, "character_sheet");
  });

  it("CharacterMediaService.removeDetailMedia accepts detail rows identified by role", async () => {
    let deleted = false;
    const service = new CharacterMediaService({
      db: {
        media: {
          findById: async () => ({
            id: "detail-media",
            workflow_id: "char-wf-1",
            step_id: "image_generation",
            mediaRole: "detail",
            url: null,
          }),
          deleteByIdAndWorkflow: async () => {
            deleted = true;
          },
        },
      },
      storageService: {},
    });

    const result = await service.removeDetailMedia({
      characterId: "char-wf-1",
      mediaId: "detail-media",
    });

    assert.equal(result.ok, true);
    assert.equal(deleted, true);
  });
});
