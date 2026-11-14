import { attachCharacterSheetResult } from "#characters/tools";
import { persistExternalMedia, getMediaRepository } from "#media/tools";
import { GenerationValidationError } from "../../../errors.js";

/**
 * SaveCharacterSheetNode (`custom.save_character_sheet`)
 *
 * Terminal persistence node (`OUTPUT_NODE: true`) for Character Turnaround Sheets.
 * Persists the character sheet media and attaches the turnaround result to the character
 * strictly via `#characters/tools` (`attachCharacterSheetResult`) and `#media/tools`.
 */
export const SaveCharacterSheetNode = {
  type: "custom.save_character_sheet",
  category: "output",
  OUTPUT_NODE: true,

  INPUT_TYPES: {
    required: {
      character_id: { type: "STRING" },
      media_id: { type: "STRING" },
      sheet_url: { type: "IMAGE_URL" },
    },
    optional: {
      panel_urls: { type: "ARRAY", default: [] },
      description: { type: "STRING", default: "" },
      metadata: { type: "JSON", default: {} },
    },
  },

  RETURN_TYPES: {
    saved_character_sheet: "JSON",
  },

  estimateCost: () => 0,

  async execute(inputs, ctx = {}) {
    if (!inputs.character_id) {
      throw new GenerationValidationError("character_id is required for custom.save_character_sheet", {
        field: "character_id",
      });
    }
    if (!inputs.media_id) {
      throw new GenerationValidationError("media_id is required for custom.save_character_sheet", {
        field: "media_id",
      });
    }
    if (!inputs.sheet_url) {
      throw new GenerationValidationError("sheet_url is required for custom.save_character_sheet", {
        field: "sheet_url",
      });
    }

    const attachFn = ctx.attachCharacterSheetResult || attachCharacterSheetResult;

    let mediaResult = null;
    if (typeof ctx.markMediaStatus === "function") {
      mediaResult = await ctx.markMediaStatus(inputs.media_id, "completed", {
        url: inputs.sheet_url,
        prompt: inputs.description || "",
        metadata: {
          panel_urls: inputs.panel_urls || [],
          ...(inputs.metadata || {}),
        },
      });
    } else if (typeof ctx.persistExternalMedia === "function" || ctx.useExternalPersistence === true) {
      const persistFn = ctx.persistExternalMedia || persistExternalMedia;
      mediaResult = await persistFn({
        mediaId: inputs.media_id,
        source: inputs.sheet_url,
        userId: ctx.userId || "system",
        saveType: "character_sheet",
        metadata: {
          prompt: inputs.description || "",
          panel_urls: inputs.panel_urls || [],
          ...(inputs.metadata || {}),
        },
      });
    } else {
      const repo = ctx.mediaRepository || getMediaRepository();
      if (!repo || typeof repo.updateFields !== "function") {
        throw new GenerationValidationError(
          "MediaRepository is not configured in #media/tools for custom.save_character_sheet"
        );
      }
      const updated = await repo.updateFields(inputs.media_id, {
        url: inputs.sheet_url,
        status: "completed",
        error_message: null,
      });
      mediaResult = {
        mediaId: updated?.id || inputs.media_id,
        id: updated?.id || inputs.media_id,
        url: updated?.url || inputs.sheet_url,
        status: updated?.status || "completed",
      };
    }

    const characterResult = await attachFn({
      characterId: inputs.character_id,
      mediaId: inputs.media_id,
      sheetUrl: inputs.sheet_url,
      userId: ctx.userId || null,
    });

    return {
      saved_character_sheet: {
        characterId: inputs.character_id,
        mediaId: inputs.media_id,
        sheetUrl: inputs.sheet_url,
        panelUrls: Array.isArray(inputs.panel_urls) ? inputs.panel_urls : [],
        description: inputs.description || "",
        character: characterResult,
        media: mediaResult,
      },
    };
  },
};

export default SaveCharacterSheetNode;

