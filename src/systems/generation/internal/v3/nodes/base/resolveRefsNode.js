import { getCharacterPromptContext } from "#characters/tools";
import { getElementPromptContext } from "#elements/tools";
import { getMediaById, getMediaUrls } from "#media/tools";
import { assertOwns, assertOwnsAny } from "#identity/tools";
import { GenerationError } from "../../../errors.js";

const INLINE_TAG_REGEX = /<(character|element):([^>\s]+)>/gi;
const isHttpUrl = (v) => typeof v === "string" && (v.startsWith("http://") || v.startsWith("https://"));
const extractUrls = (obj) =>
  (Array.isArray(obj.referenceMediaUrls) ? obj.referenceMediaUrls : Array.isArray(obj.imageUrls) ? obj.imageUrls : []).filter(Boolean);
const formatTraits = (traits) =>
  Array.isArray(traits)
    ? traits
    : traits && typeof traits === "object"
      ? Object.entries(traits).map(([k, v]) => `${k}: ${v}`)
      : [];

function toOwnershipGenerationError(err, resourceId = null) {
  if (err instanceof GenerationError) return err;
  const status = err?.statusCode || err?.status || 403;
  return new GenerationError({
    code: err?.code || "OWNERSHIP_VERIFICATION_FAILED",
    message: err?.message || `Access denied to referenced resource "${resourceId || ""}"`,
    userMessage: "You do not have permission to use one or more referenced resources.",
    status,
    statusCode: status,
    category: "USER_FAULT",
    retryable: false,
    isInternal: false,
    context: { resourceId },
  });
}

/**
 * ResolveRefsNode (`base.resolve_references`)
 *
 * Step 1 in V3 workflows: verifies ownership via `#identity/tools`, resolves characters,
 * elements, and media references, replaces inline `<character:id>` / `<element:id>` tags
 * with `@Name` or `@imageN`, and embeds the deterministic `[Reference Guide]` in `prepared_prompt`.
 */
export const ResolveRefsNode = {
  type: "base.resolve_references",
  category: "context",
  OUTPUT_NODE: false,

  INPUT_TYPES: {
    required: {},
    optional: {
      prompt: { type: "STRING", default: "" },
      references: { type: "ARRAY", default: [] },
      characters: { type: "ARRAY", default: [] },
      elements: { type: "ARRAY", default: [] },
      media_id: { type: "STRING" },
      verify_ownership: { type: "BOOLEAN", default: true },
    },
  },

  RETURN_TYPES: {
    status: "STRING",
    prepared_prompt: "STRING",
    reference_urls: "ARRAY",
    entities: "ARRAY",
    media_url: "IMAGE_URL",
  },

  estimateCost: () => 0,

  async execute(inputs = {}, ctx = {}) {
    const userId = ctx.userId || null;
    const verifyOwnership = inputs.verify_ownership === undefined ? true : inputs.verify_ownership === true;
    const getCharacterFn = ctx.getCharacterPromptContext || getCharacterPromptContext;
    const getElementFn = ctx.getElementPromptContext || getElementPromptContext;
    const getMediaByIdFn = ctx.getMediaById || getMediaById;
    const getMediaUrlsFn = ctx.getMediaUrls || getMediaUrls;
    const assertOwnsFn = ctx.assertOwns || assertOwns;
    const assertOwnsAnyFn = ctx.assertOwnsAny || assertOwnsAny;

    const checkOwnership = async (types, resourceId, { useSingleAssertOwns = false, strictFlag = false } = {}) => {
      if (!userId || verifyOwnership !== true) return true;
      try {
        if (useSingleAssertOwns && ctx.assertOwns) {
          await assertOwnsFn(types[0], resourceId, userId);
        } else {
          await assertOwnsAnyFn(types, resourceId, userId);
        }
        return true;
      } catch (err) {
        if (ctx.strictOwnership === true || strictFlag === true) {
          throw toOwnershipGenerationError(err, resourceId);
        }
        return false;
      }
    };

    const rawPromptInput = typeof inputs.prompt === "string" ? inputs.prompt.trim() : "";
    const inlineCharacterIds = [];
    const inlineElementIds = [];
    if (rawPromptInput) {
      for (const [, kind, rawId] of rawPromptInput.matchAll(INLINE_TAG_REGEX)) {
        const tagId = rawId.trim();
        if (tagId) (kind.toLowerCase() === "character" ? inlineCharacterIds : inlineElementIds).push(tagId);
      }
    }

    const entities = [];
    const entityById = new Map();
    const referenceUrls = [];

    const registerReferenceUrl = (url) => {
      if (!url || typeof url !== "string" || !url.startsWith("http")) return null;
      let idx = referenceUrls.indexOf(url);
      if (idx === -1) idx = referenceUrls.push(url) - 1;
      return `@image${idx + 1}`;
    };

    const addEntity = (entity) => {
      if (!entity) return;
      entities.push(entity);
      if (entity.id) entityById.set(String(entity.id), entity);
      if (entity.workflowId) entityById.set(String(entity.workflowId), entity);
    };

    const addMediaEntity = (id, url, name = "Image Reference") => {
      registerReferenceUrl(url);
      addEntity({
        id,
        workflowId: id,
        entityType: "media",
        name,
        description: null,
        visualTraits: [],
        imageUrls: [url],
      });
    };

    const addCharacterEntity = (id, src, fallbackName = "Character") => {
      const urls = extractUrls(src);
      urls.forEach(registerReferenceUrl);
      addEntity({
        id,
        workflowId: src.workflowId || id,
        entityType: "character",
        name: src.name || fallbackName,
        description: src.description || "",
        visualTraits: Array.isArray(src.visualTraits) ? src.visualTraits : formatTraits(src.traits),
        imageUrls: urls,
        sheetImages: Array.isArray(src.sheetImages) ? src.sheetImages : urls,
        detailImages: Array.isArray(src.detailImages) ? src.detailImages : [],
      });
    };

    const addElementEntity = (id, src) => {
      const urls = extractUrls(src);
      urls.forEach(registerReferenceUrl);
      addEntity({
        id,
        workflowId: src.workflowId || id,
        entityType: "element",
        name: src.name || "Element",
        description: src.description || "",
        visualTraits: Array.isArray(src.visualTraits) ? src.visualTraits : src.guidelines ? [src.guidelines] : [],
        imageUrls: urls,
        sheetImages: [],
        detailImages: urls,
      });
    };

    // 0. Optional single media_id load
    let loadedMediaUrl = null;
    if (typeof inputs.media_id === "string" && inputs.media_id.trim()) {
      const mId = inputs.media_id.trim();
      if (isHttpUrl(mId)) {
        loadedMediaUrl = mId;
        addMediaEntity("source_image", mId, "Source Image");
      } else if (await checkOwnership(["media", "workflow"], mId, { strictFlag: ctx.strictMediaLoad === true })) {
        let record = await getMediaByIdFn(mId);
        if (!record) {
          const list = await getMediaUrlsFn([mId]);
          if (Array.isArray(list) && list.length > 0) record = list[0];
        }
        if (record?.url) {
          loadedMediaUrl = record.url;
          addMediaEntity(record.id || record.mediaId || mId, record.url, "Media Reference");
        }
      }
    }

    // 1. Resolve characters (explicit inputs.characters + inline <character:id>)
    const rawCharacters = [...(Array.isArray(inputs.characters) ? inputs.characters : []), ...inlineCharacterIds];
    const seenCharIds = new Set();
    for (let i = 0; i < rawCharacters.length; i++) {
      const charItem = rawCharacters[i];
      if (!charItem) continue;
      if (typeof charItem === "object" && (charItem.name || charItem.description)) {
        const cId = charItem.id || charItem.characterId || `char_${i + 1}`;
        if (seenCharIds.has(cId)) continue;
        seenCharIds.add(cId);
        addCharacterEntity(cId, charItem, `Character ${i + 1}`);
        continue;
      }
      const charId = typeof charItem === "string" ? charItem.trim() : (charItem.id || charItem.characterId || "").trim();
      if (!charId || seenCharIds.has(charId)) continue;
      seenCharIds.add(charId);
      if (!(await checkOwnership(["character", "workflow"], charId, { useSingleAssertOwns: true }))) continue;
      const charCtx = await getCharacterFn({ characterId: charId, userId });
      if (charCtx) addCharacterEntity(charId, charCtx);
    }

    // 2. Resolve elements (explicit inputs.elements + inline <element:id>)
    const rawElements = [...(Array.isArray(inputs.elements) ? inputs.elements : []), ...inlineElementIds];
    const elementIds = [];
    for (const e of rawElements) {
      if (!e) continue;
      if (typeof e === "object" && (e.name || e.description || e.guidelines)) {
        const eId = e.id || e.elementId || `elem_${entities.length + 1}`;
        if (!entityById.has(eId)) addElementEntity(eId, e);
        continue;
      }
      const idStr = typeof e === "string" ? e.trim() : (e?.id || e?.elementId || "").trim();
      if (idStr && !elementIds.includes(idStr)) elementIds.push(idStr);
    }

    if (elementIds.length > 0) {
      const verifiedElemIds = [];
      for (const eId of elementIds) {
        if (await checkOwnership(["element", "workflow"], eId)) verifiedElemIds.push(eId);
      }
      if (verifiedElemIds.length > 0) {
        const elemResult = await getElementFn({ elementIds: verifiedElemIds, userId });
        for (const elem of elemResult?.elements || []) addElementEntity(elem.id, elem);
      }
    }

    // 3. Resolve generic references (URLs or media/character/element IDs)
    const mediaIdsToLookup = [];
    for (const ref of Array.isArray(inputs.references) ? inputs.references : []) {
      if (!ref) continue;
      if (typeof ref === "object" && (ref.entityType === "character" || ref.entityType === "element") && ref.name) {
        (Array.isArray(ref.imageUrls) ? ref.imageUrls.filter(Boolean) : []).forEach(registerReferenceUrl);
        addEntity(ref);
        continue;
      }
      const val = typeof ref === "string" ? ref.trim() : (ref.url || ref.id || ref.mediaId || ref.workflowId || "").trim();
      if (!val) continue;
      if (isHttpUrl(val)) {
        addMediaEntity(val, val, (typeof ref === "object" && ref.name) || "Image Reference");
      } else {
        mediaIdsToLookup.push(val);
      }
    }

    for (const mId of mediaIdsToLookup) {
      if (entityById.has(mId)) continue;
      if (!(await checkOwnership(["media", "workflow", "character", "element"], mId))) continue;
      for (const m of (await getMediaUrlsFn([mId])) || []) {
        if (m?.url) addMediaEntity(m.mediaId || m.id || mId, m.url);
      }
    }

    // 4. Replace inline <character:id> and <element:id> tags with @Name or @imageN
    const processedPrompt = rawPromptInput
      ? rawPromptInput
          .replace(INLINE_TAG_REGEX, (_match, _kind, rawId) => {
            const id = rawId.trim();
            const entity = entityById.get(id);
            if (!entity) return "";
            if (entity.name && (entity.entityType === "character" || entity.entityType === "element")) {
              return `@${entity.name}`;
            }
            const imgTag = Array.isArray(entity.imageUrls) && entity.imageUrls[0] ? registerReferenceUrl(entity.imageUrls[0]) : null;
            return imgTag || `@${entity.name || id}`;
          })
          .replace(/\s{2,}/g, " ")
          .trim()
      : "";

    // 5. Build [Reference Guide] and assemble prepared_prompt
    const guideLines = [];
    const entityMentions = [];
    for (const entity of entities) {
      if (!entity || typeof entity !== "object") continue;
      const name = entity.name || "Entity";
      const type = entity.entityType || "reference";
      const tags = (Array.isArray(entity.imageUrls) ? entity.imageUrls : []).map(registerReferenceUrl).filter(Boolean);

      if (type === "character" || type === "element") {
        const tag = `@${name}`;
        if (!processedPrompt || !processedPrompt.toLowerCase().includes(tag.toLowerCase())) entityMentions.push(tag);
        const card = [`@${name} (${type})`];
        if (entity.description) card.push(`  description: ${String(entity.description).trim()}`);
        if (Array.isArray(entity.visualTraits) && entity.visualTraits.length > 0) card.push(`  traits: ${entity.visualTraits.join(", ")}`);
        if (tags.length > 0) card.push(`  visual references: ${tags.join(", ")}`);
        guideLines.push(card.join("\n"));
      } else if (tags.length > 0) {
        guideLines.push(`${name} (image reference) — ${tags[0]}`);
      }
    }

    const promptParts = [];
    if (entityMentions.length > 0) promptParts.push(entityMentions.join(", "));
    if (processedPrompt) promptParts.push(processedPrompt);
    const referenceGuide = guideLines.length > 0 ? `[Reference Guide]\n${guideLines.join("\n\n")}` : "";
    const basePrepared = promptParts.join(", ").trim();
    const prepared_prompt = referenceGuide ? `${basePrepared}${basePrepared ? "\n\n" : ""}${referenceGuide}`.trim() : basePrepared;

    return {
      status: "success",
      prepared_prompt,
      reference_urls: referenceUrls,
      entities,
      media_url: loadedMediaUrl || referenceUrls[0] || "",
    };
  },
};

export default ResolveRefsNode;
