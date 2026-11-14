import { getCharacterPromptContext } from "#characters/tools";
import { getElementPromptContext } from "#elements/tools";
import { getMediaUrls } from "#media/tools";
import { assertOwns, assertOwnsAny } from "#identity/tools";

/**
 * ResolveRefsNode (`base.resolve_references`)
 *
 * Resolves characters, elements, and media references strictly through
 * `#characters/tools`, `#elements/tools`, `#media/tools`, and `#identity/tools`.
 */
export const ResolveRefsNode = {
  type: "base.resolve_references",
  category: "context",
  OUTPUT_NODE: false,

  INPUT_TYPES: {
    required: {},
    optional: {
      references: { type: "ARRAY", default: [] },
      characters: { type: "ARRAY", default: [] },
      elements: { type: "ARRAY", default: [] },
    },
  },

  RETURN_TYPES: {
    entities: "ARRAY",
    reference_urls: "ARRAY",
    context: "JSON",
  },

  estimateCost: () => 0,

  async execute(inputs = {}, ctx = {}) {
    const userId = ctx.userId || null;
    const getCharacterFn = ctx.getCharacterPromptContext || getCharacterPromptContext;
    const getElementFn = ctx.getElementPromptContext || getElementPromptContext;
    const getMediaUrlsFn = ctx.getMediaUrls || getMediaUrls;
    const assertOwnsFn = ctx.assertOwns || assertOwns;
    const assertOwnsAnyFn = ctx.assertOwnsAny || assertOwnsAny;

    const entities = [];
    const referenceUrlsSet = new Set();

    // 1. Resolve character references
    const rawCharacters = Array.isArray(inputs.characters) ? inputs.characters : [];
    for (let i = 0; i < rawCharacters.length; i++) {
      const charItem = rawCharacters[i];
      if (!charItem) continue;

      if (typeof charItem === "object" && (charItem.name || charItem.description)) {
        const inlineUrls = Array.isArray(charItem.referenceMediaUrls)
          ? charItem.referenceMediaUrls
          : Array.isArray(charItem.imageUrls)
            ? charItem.imageUrls
            : [];
        inlineUrls.filter(Boolean).forEach((u) => referenceUrlsSet.add(u));
        entities.push({
          id: charItem.id || charItem.characterId || `char_${i + 1}`,
          workflowId: charItem.workflowId || charItem.id || `char_${i + 1}`,
          entityType: "character",
          name: charItem.name || `Character ${i + 1}`,
          description: charItem.description || "",
          visualTraits: Array.isArray(charItem.visualTraits)
            ? charItem.visualTraits
            : Object.entries(charItem.traits || {}).map(([k, v]) => `${k}: ${v}`),
          imageUrls: inlineUrls,
          sheetImages: Array.isArray(charItem.sheetImages) ? charItem.sheetImages : inlineUrls,
          detailImages: Array.isArray(charItem.detailImages) ? charItem.detailImages : [],
        });
        continue;
      }

      const charId = typeof charItem === "string" ? charItem : charItem.id || charItem.characterId;
      if (!charId) continue;

      if (userId && ctx.assertOwns) {
        await assertOwnsFn("character", charId, userId);
      }

      const charCtx = await getCharacterFn({ characterId: charId, userId });
      if (charCtx) {
        const urls = Array.isArray(charCtx.referenceMediaUrls) ? charCtx.referenceMediaUrls.filter(Boolean) : [];
        urls.forEach((u) => referenceUrlsSet.add(u));
        const traitsList =
          charCtx.traits && typeof charCtx.traits === "object" && !Array.isArray(charCtx.traits)
            ? Object.entries(charCtx.traits).map(([k, v]) => `${k}: ${v}`)
            : Array.isArray(charCtx.traits)
              ? charCtx.traits
              : [];
        entities.push({
          id: charId,
          workflowId: charId,
          entityType: "character",
          name: charCtx.name || "Character",
          description: charCtx.description || "",
          visualTraits: traitsList,
          imageUrls: urls,
          sheetImages: urls,
          detailImages: [],
        });
      }
    }

    // 2. Resolve element references
    const rawElements = Array.isArray(inputs.elements) ? inputs.elements : [];
    const elementIds = rawElements
      .map((e) => (typeof e === "string" ? e : e?.id || e?.elementId))
      .filter(Boolean);

    if (elementIds.length > 0) {
      const elemResult = await getElementFn({ elementIds, userId });
      for (const elem of elemResult?.elements || []) {
        const urls = Array.isArray(elem.referenceMediaUrls) ? elem.referenceMediaUrls.filter(Boolean) : [];
        urls.forEach((u) => referenceUrlsSet.add(u));
        entities.push({
          id: elem.id,
          workflowId: elem.workflowId || elem.id,
          entityType: "element",
          name: elem.name || "Element",
          description: elem.description || "",
          visualTraits: elem.guidelines ? [elem.guidelines] : [],
          imageUrls: urls,
          sheetImages: [],
          detailImages: urls,
        });
      }
    }

    // 3. Resolve generic references (URLs or media IDs)
    const rawRefs = Array.isArray(inputs.references) ? inputs.references : [];
    const mediaIdsToLookup = [];

    for (const ref of rawRefs) {
      if (!ref) continue;
      const val = typeof ref === "string" ? ref.trim() : (ref.url || ref.id || ref.mediaId || ref.workflowId || "").trim();
      if (!val) continue;

      if (val.startsWith("http://") || val.startsWith("https://")) {
        referenceUrlsSet.add(val);
        entities.push({
          id: val,
          workflowId: val,
          entityType: "media",
          name: (typeof ref === "object" && ref.name) || "Image Reference",
          description: null,
          visualTraits: [],
          imageUrls: [val],
        });
      } else {
        mediaIdsToLookup.push(val);
      }
    }

    if (mediaIdsToLookup.length > 0) {
      if (userId && ctx.assertOwnsAny) {
        for (const mId of mediaIdsToLookup) {
          await assertOwnsAnyFn(["media", "workflow", "character", "element"], mId, userId);
        }
      }
      const mediaRecords = await getMediaUrlsFn(mediaIdsToLookup);
      for (const m of mediaRecords || []) {
        if (m?.url) {
          referenceUrlsSet.add(m.url);
          entities.push({
            id: m.mediaId || m.id,
            workflowId: m.mediaId || m.id,
            entityType: "media",
            name: "Image Reference",
            description: null,
            visualTraits: [],
            imageUrls: [m.url],
          });
        }
      }
    }

    const referenceUrls = Array.from(referenceUrlsSet);

    return {
      entities,
      reference_urls: referenceUrls,
      context: {
        entities,
        referenceUrls,
        resolvedCount: entities.length,
      },
    };
  },
};

export default ResolveRefsNode;
