import { getCharacterPromptContext } from "#characters/tools";
import { getElementPromptContext } from "#elements/tools";
import { getMediaById, getMediaUrls } from "#media/tools";
import { assertOwns, assertOwnsAny } from "#identity/tools";

const INLINE_TAG_REGEX = /<(character|element):([^>\s]+)>/gi;

/**
 * ResolveRefsNode (`base.resolve_references`)
 *
 * Step 1 in every V3 workflow:
 * - Verifies user ownership of referenced characters, elements, and media via `#identity/tools` (`assertOwns` / `assertOwnsAny`).
 * - Resolves characters (`#characters/tools`), elements (`#elements/tools`), and media/input_media (`#media/tools`).
 * - Numbers reference images (`@image1..N`), replaces inline `<character:id>` / `<element:id>` tags in the user prompt
 *   with `@Name` or `@imageN`, and builds the deterministic `[Reference Guide]` block.
 */
export const ResolveRefsNode = {
  type: "base.resolve_references",
  category: "context",
  OUTPUT_NODE: false,

  INPUT_TYPES: {
    required: {},
    optional: {
      prompt: { type: "STRING", default: "" },
      style: { type: "STRING", default: "" },
      template_suffix: { type: "STRING", default: "" },
      references: { type: "ARRAY", default: [] },
      characters: { type: "ARRAY", default: [] },
      elements: { type: "ARRAY", default: [] },
      media_id: { type: "STRING" },
      verify_ownership: { type: "BOOLEAN", default: true },
    },
  },

  RETURN_TYPES: {
    prepared_prompt: "STRING",
    reference_guide: "STRING",
    reference_urls: "ARRAY",
    entities_context: "JSON",
    entities: "ARRAY",
    context: "JSON",
    media_url: "IMAGE_URL",
    video_url: "VIDEO_URL",
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

    const rawPromptInput = typeof inputs.prompt === "string" ? inputs.prompt.trim() : "";

    // Extract any inline <character:id> and <element:id> tags from the user prompt
    const inlineCharacterIds = [];
    const inlineElementIds = [];
    if (rawPromptInput) {
      let match;
      INLINE_TAG_REGEX.lastIndex = 0;
      while ((match = INLINE_TAG_REGEX.exec(rawPromptInput)) !== null) {
        const tagKind = match[1].toLowerCase();
        const tagId = match[2].trim();
        if (!tagId) continue;
        if (tagKind === "character") {
          inlineCharacterIds.push(tagId);
        } else if (tagKind === "element") {
          inlineElementIds.push(tagId);
        }
      }
    }

    const entities = [];
    const entityById = new Map();
    const referenceUrls = [];

    const registerReferenceUrl = (url) => {
      if (!url || typeof url !== "string" || !url.startsWith("http")) return null;
      let idx = referenceUrls.indexOf(url);
      if (idx === -1) {
        referenceUrls.push(url);
        idx = referenceUrls.length - 1;
      }
      return `@image${idx + 1}`;
    };

    const addEntity = (entity) => {
      if (!entity) return;
      entities.push(entity);
      if (entity.id) entityById.set(String(entity.id), entity);
      if (entity.workflowId) entityById.set(String(entity.workflowId), entity);
    };

    // 0. Optional single media_id load (merged from base.load_media)
    let loadedMediaUrl = null;
    if (typeof inputs.media_id === "string" && inputs.media_id.trim()) {
      const mId = inputs.media_id.trim();
      if (mId.startsWith("http://") || mId.startsWith("https://")) {
        loadedMediaUrl = mId;
        registerReferenceUrl(mId);
      } else {
        let canAccess = true;
        if (userId && verifyOwnership === true) {
          try {
            await assertOwnsAnyFn(["media", "workflow"], mId, userId);
          } catch (err) {
            if (ctx.strictMediaLoad === true) throw err;
            canAccess = false;
          }
        }
        if (canAccess) {
          let record = await getMediaByIdFn(mId);
          if (!record) {
            const list = await getMediaUrlsFn([mId]);
            if (Array.isArray(list) && list.length > 0) {
              record = list[0];
            }
          }
          if (record?.url) {
            loadedMediaUrl = record.url;
            registerReferenceUrl(record.url);
            addEntity({
              id: record.id || record.mediaId || mId,
              workflowId: record.id || record.mediaId || mId,
              entityType: "media",
              name: "Media Reference",
              description: null,
              visualTraits: [],
              imageUrls: [record.url],
            });
          }
        }
      }
    }

    // 1. Resolve character references (explicit inputs.characters + inline <character:id>)
    const rawCharacters = [
      ...(Array.isArray(inputs.characters) ? inputs.characters : []),
      ...inlineCharacterIds,
    ];
    const seenCharIds = new Set();

    for (let i = 0; i < rawCharacters.length; i++) {
      const charItem = rawCharacters[i];
      if (!charItem) continue;

      if (typeof charItem === "object" && (charItem.name || charItem.description)) {
        const inlineUrls = Array.isArray(charItem.referenceMediaUrls)
          ? charItem.referenceMediaUrls
          : Array.isArray(charItem.imageUrls)
            ? charItem.imageUrls
            : [];
        const cleanUrls = inlineUrls.filter(Boolean);
        cleanUrls.forEach(registerReferenceUrl);
        const cId = charItem.id || charItem.characterId || `char_${i + 1}`;
        if (seenCharIds.has(cId)) continue;
        seenCharIds.add(cId);

        addEntity({
          id: cId,
          workflowId: charItem.workflowId || cId,
          entityType: "character",
          name: charItem.name || `Character ${i + 1}`,
          description: charItem.description || "",
          visualTraits: Array.isArray(charItem.visualTraits)
            ? charItem.visualTraits
            : Object.entries(charItem.traits || {}).map(([k, v]) => `${k}: ${v}`),
          imageUrls: cleanUrls,
          sheetImages: Array.isArray(charItem.sheetImages) ? charItem.sheetImages : cleanUrls,
          detailImages: Array.isArray(charItem.detailImages) ? charItem.detailImages : [],
        });
        continue;
      }

      const charId = typeof charItem === "string" ? charItem.trim() : (charItem.id || charItem.characterId || "").trim();
      if (!charId || seenCharIds.has(charId)) continue;
      seenCharIds.add(charId);

      if (userId && verifyOwnership === true) {
        try {
          if (ctx.assertOwns) {
            await assertOwnsFn("character", charId, userId);
          } else {
            await assertOwnsAnyFn(["character", "workflow"], charId, userId);
          }
        } catch {
          continue;
        }
      }

      const charCtx = await getCharacterFn({ characterId: charId, userId });
      if (charCtx) {
        const urls = Array.isArray(charCtx.referenceMediaUrls) ? charCtx.referenceMediaUrls.filter(Boolean) : [];
        urls.forEach(registerReferenceUrl);
        const traitsList =
          charCtx.traits && typeof charCtx.traits === "object" && !Array.isArray(charCtx.traits)
            ? Object.entries(charCtx.traits).map(([k, v]) => `${k}: ${v}`)
            : Array.isArray(charCtx.traits)
              ? charCtx.traits
              : [];
        addEntity({
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

    // 2. Resolve element references (explicit inputs.elements + inline <element:id>)
    const rawElements = [
      ...(Array.isArray(inputs.elements) ? inputs.elements : []),
      ...inlineElementIds,
    ];
    const elementIds = [];
    for (const e of rawElements) {
      if (!e) continue;
      if (typeof e === "object" && (e.name || e.description || e.guidelines)) {
        const urls = Array.isArray(e.referenceMediaUrls)
          ? e.referenceMediaUrls.filter(Boolean)
          : Array.isArray(e.imageUrls)
            ? e.imageUrls.filter(Boolean)
            : [];
        urls.forEach(registerReferenceUrl);
        const eId = e.id || e.elementId || `elem_${entities.length + 1}`;
        if (!entityById.has(eId)) {
          addEntity({
            id: eId,
            workflowId: e.workflowId || eId,
            entityType: "element",
            name: e.name || "Element",
            description: e.description || "",
            visualTraits: Array.isArray(e.visualTraits)
              ? e.visualTraits
              : e.guidelines
                ? [e.guidelines]
                : [],
            imageUrls: urls,
            sheetImages: [],
            detailImages: urls,
          });
        }
        continue;
      }
      const idStr = typeof e === "string" ? e.trim() : (e?.id || e?.elementId || "").trim();
      if (idStr && !elementIds.includes(idStr)) {
        elementIds.push(idStr);
      }
    }

    if (elementIds.length > 0) {
      const verifiedElemIds = [];
      for (const eId of elementIds) {
        if (userId && verifyOwnership === true) {
          try {
            await assertOwnsAnyFn(["element", "workflow"], eId, userId);
            verifiedElemIds.push(eId);
          } catch {
            continue;
          }
        } else {
          verifiedElemIds.push(eId);
        }
      }

      if (verifiedElemIds.length > 0) {
        const elemResult = await getElementFn({ elementIds: verifiedElemIds, userId });
        for (const elem of elemResult?.elements || []) {
          const urls = Array.isArray(elem.referenceMediaUrls) ? elem.referenceMediaUrls.filter(Boolean) : [];
          urls.forEach(registerReferenceUrl);
          addEntity({
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
    }

    // 3. Resolve generic references (URLs or media/character/element IDs)
    const rawRefs = Array.isArray(inputs.references) ? inputs.references : [];
    const mediaIdsToLookup = [];

    for (const ref of rawRefs) {
      if (!ref) continue;
      if (typeof ref === "object" && (ref.entityType === "character" || ref.entityType === "element") && ref.name) {
        const urls = Array.isArray(ref.imageUrls) ? ref.imageUrls.filter(Boolean) : [];
        urls.forEach(registerReferenceUrl);
        addEntity(ref);
        continue;
      }
      const val =
        typeof ref === "string"
          ? ref.trim()
          : (ref.url || ref.id || ref.mediaId || ref.workflowId || "").trim();
      if (!val) continue;

      if (val.startsWith("http://") || val.startsWith("https://")) {
        registerReferenceUrl(val);
        addEntity({
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
      for (const mId of mediaIdsToLookup) {
        if (entityById.has(mId)) continue;
        if (userId && verifyOwnership === true) {
          try {
            await assertOwnsAnyFn(["media", "workflow", "character", "element"], mId, userId);
          } catch {
            continue;
          }
        }
        const mediaRecords = await getMediaUrlsFn([mId]);
        for (const m of mediaRecords || []) {
          if (m?.url) {
            registerReferenceUrl(m.url);
            addEntity({
              id: m.mediaId || m.id || mId,
              workflowId: m.mediaId || m.id || mId,
              entityType: "media",
              name: "Image Reference",
              description: null,
              visualTraits: [],
              imageUrls: [m.url],
            });
          }
        }
      }
    }

    // 4. Replace inline <character:id> and <element:id> tags in user prompt with @Name or @imageN
    let processedPrompt = rawPromptInput;
    if (processedPrompt) {
      processedPrompt = processedPrompt.replace(INLINE_TAG_REGEX, (fullMatch, kind, rawId) => {
        const id = rawId.trim();
        const entity = entityById.get(id);
        if (!entity) {
          return "";
        }
        if (entity.name && (entity.entityType === "character" || entity.entityType === "element")) {
          return `@${entity.name}`;
        }
        if (Array.isArray(entity.imageUrls) && entity.imageUrls.length > 0) {
          const imgTag = registerReferenceUrl(entity.imageUrls[0]);
          if (imgTag) return imgTag;
        }
        return `@${entity.name || id}`;
      }).replace(/\s{2,}/g, " ").trim();
    }

    // 5. Build [Reference Guide] and entity mentions
    const guideLines = [];
    const entityMentions = [];

    for (const entity of entities) {
      if (!entity || typeof entity !== "object") continue;
      const name = entity.name || "Entity";
      const type = entity.entityType || "reference";
      const urls = Array.isArray(entity.imageUrls) ? entity.imageUrls : [];
      const tags = urls.map(registerReferenceUrl).filter(Boolean);

      if (type === "character" || type === "element") {
        const tag = `@${name}`;
        if (processedPrompt && !processedPrompt.toLowerCase().includes(tag.toLowerCase())) {
          entityMentions.push(tag);
        } else if (!processedPrompt) {
          entityMentions.push(tag);
        }
        const card = [`@${name} (${type})`];
        if (entity.description) {
          card.push(`  description: ${String(entity.description).trim()}`);
        }
        if (Array.isArray(entity.visualTraits) && entity.visualTraits.length > 0) {
          card.push(`  traits: ${entity.visualTraits.join(", ")}`);
        }
        if (tags.length > 0) {
          card.push(`  visual references: ${tags.join(", ")}`);
        }
        guideLines.push(card.join("\n"));
      } else if (tags.length > 0) {
        guideLines.push(`${name} (image reference) — ${tags[0]}`);
      }
    }

    const promptParts = [];
    if (entityMentions.length > 0) {
      promptParts.push(entityMentions.join(", "));
    }
    if (processedPrompt) {
      promptParts.push(processedPrompt);
    }
    if (inputs.style && typeof inputs.style === "string" && inputs.style.trim()) {
      promptParts.push(inputs.style.trim());
    }
    if (inputs.template_suffix && typeof inputs.template_suffix === "string" && inputs.template_suffix.trim()) {
      promptParts.push(inputs.template_suffix.trim());
    }

    const referenceGuide = guideLines.length > 0 ? `[Reference Guide]\n${guideLines.join("\n\n")}` : "";
    const basePrepared = promptParts.join(", ").trim();
    const preparedPrompt = referenceGuide
      ? `${basePrepared}${basePrepared ? "\n\n" : ""}${referenceGuide}`.trim()
      : basePrepared;

    const entitiesContext = {
      entities,
      referenceUrls,
      referenceGuide,
      resolvedCount: entities.length,
    };

    const primaryMediaUrl = loadedMediaUrl || referenceUrls[0] || "";

    return {
      prepared_prompt: preparedPrompt,
      reference_guide: referenceGuide,
      reference_urls: referenceUrls,
      entities_context: entitiesContext,
      entities,
      context: entitiesContext,
      media_url: primaryMediaUrl,
      video_url: primaryMediaUrl,
    };
  },
};

export default ResolveRefsNode;
