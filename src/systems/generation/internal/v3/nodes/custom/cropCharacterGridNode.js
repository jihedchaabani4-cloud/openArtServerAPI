import sharp from "sharp";
import { SourceReader, getMediaUploadService, DEFAULT_UPLOAD_POLICY } from "#media/tools";
import { GenerationValidationError, GenerationUpstreamError } from "../../../errors.js";

/**
 * CropCharacterGridNode (`custom.crop_character_grid`)
 *
 * Splits a 16:9 3-panel character turnaround sheet into 3 individual panel views
 * (`front`, `side`, `back`) using `sharp` and uploads them via `#media/tools`.
 * If `ctx.sheetBuffer` is not provided, reads the image bytes from `inputs.sheet_url`
 * via `SourceReader` in `#media/tools`.
 */
export const CropCharacterGridNode = {
  type: "custom.crop_character_grid",
  category: "character",
  OUTPUT_NODE: false,

  INPUT_TYPES: {
    required: {
      sheet_url: { type: "IMAGE_URL" },
    },
    optional: {
      panels: { type: "INT", default: 3 },
      width: { type: "INT", default: 1344 },
      height: { type: "INT", default: 768 },
    },
  },

  RETURN_TYPES: {
    sheet_url: "IMAGE_URL",
    panel_urls: "ARRAY",
    front_url: "IMAGE_URL",
    side_url: "IMAGE_URL",
    back_url: "IMAGE_URL",
  },

  estimateCost: () => 0,

  async execute(inputs, ctx = {}) {
    if (!inputs.sheet_url || typeof inputs.sheet_url !== "string") {
      throw new GenerationValidationError("sheet_url is required for custom.crop_character_grid", {
        field: "sheet_url",
      });
    }

    const requestedWidth = Number(inputs.width || 1344);
    const requestedHeight = Number(inputs.height || 768);
    const panelsCount = Math.max(1, Number(inputs.panels || 3));

    // Allow injected crop/upload override for custom pipelines
    if (typeof ctx.cropCharacterSheet === "function") {
      const customRes = await ctx.cropCharacterSheet({
        sheetUrl: inputs.sheet_url,
        panels: panelsCount,
        width: requestedWidth,
        height: requestedHeight,
        userId: ctx.userId || null,
      });
      const urls = customRes?.panelUrls || [];
      if (urls.length === 0) {
        throw new GenerationUpstreamError("custom.crop_character_grid failed to produce panel URLs");
      }
      return {
        sheet_url: inputs.sheet_url,
        panel_urls: urls,
        front_url: urls[0],
        side_url: urls[1] || urls[0],
        back_url: urls[2] || urls[0],
      };
    }

    // 1. Obtain image Buffer from ctx.sheetBuffer or fetch via SourceReader (#media/tools)
    let sourceBuffer = Buffer.isBuffer(ctx.sheetBuffer) ? ctx.sheetBuffer : null;
    if (!sourceBuffer) {
      const readFn =
        typeof ctx.readSourceBuffer === "function"
          ? ctx.readSourceBuffer
          : async (url) => {
              const readRes = await SourceReader.read({ kind: "url", value: url }, DEFAULT_UPLOAD_POLICY);
              return readRes.buffer;
            };
      sourceBuffer = await readFn(inputs.sheet_url);
    }

    if (!Buffer.isBuffer(sourceBuffer) || sourceBuffer.length === 0) {
      throw new GenerationUpstreamError(
        `Failed to obtain image buffer from sheet_url "${inputs.sheet_url}" for custom.crop_character_grid`
      );
    }

    // 2. Inspect actual image dimensions via sharp and slice into N panels
    const metadata = await sharp(sourceBuffer).metadata();
    const totalWidth = metadata.width || requestedWidth;
    const totalHeight = metadata.height || requestedHeight;
    const panelWidth = Math.floor(totalWidth / panelsCount);

    if (panelWidth < 1 || totalHeight < 1) {
      throw new GenerationValidationError("Invalid sheet dimensions for custom.crop_character_grid");
    }

    const buffers = [];
    for (let i = 0; i < panelsCount; i++) {
      const left = i * panelWidth;
      const cropped = await sharp(sourceBuffer)
        .extract({ left, top: 0, width: panelWidth, height: totalHeight })
        .png()
        .toBuffer();
      buffers.push(cropped);
    }

    // 3. Upload cropped panel buffers via #media/tools
    const uploadService = ctx.mediaUploadService || getMediaUploadService();
    const uploaded = await uploadService.upload({
      files: buffers,
      policy: DEFAULT_UPLOAD_POLICY,
      userId: ctx.userId || "system",
      folder: "characters/panels",
    });

    const urls = (uploaded || []).map((u) => u?.url).filter(Boolean);
    if (urls.length < panelsCount) {
      throw new GenerationUpstreamError(
        `Failed to upload all ${panelsCount} character sheet panels to storage`
      );
    }

    return {
      sheet_url: inputs.sheet_url,
      panel_urls: urls,
      front_url: urls[0],
      side_url: urls[1] || urls[0],
      back_url: urls[2] || urls[0],
    };
  },
};

export default CropCharacterGridNode;

