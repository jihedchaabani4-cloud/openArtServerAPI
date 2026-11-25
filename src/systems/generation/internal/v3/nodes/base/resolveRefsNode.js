import { getCharacterPromptContext } from "#characters/tools";
import { getElementPromptContext } from "#elements/tools";
import { getMediaById, getMediaUrls, getWorkflowPrimaryMedia } from "#media/tools";
import { assertOwns, assertOwnsAny } from "#identity/tools";
import { GenerationError } from "../../../errors.js";

const INLINE_TAG_REGEX = /<(character|element):([^>\s]+)>/gi;
const INACTIVE_MEDIA_STATUSES = new Set(["failed", "saved", "processing", "pending", "queued", "uploading", "in_progress", "starting"]);
const isHttpUrl = (v) => {
  if (typeof v !== "string") return false;
  const trimmed = v.trim();
  return trimmed.startsWith("http://") || trimmed.startsWith("https://");
};
const isUsableMediaRecord = (m) => {
  if (!m || !isHttpUrl(m.url)) return false;
  if (typeof m.status === "string" && m.status.trim()) {
    return !INACTIVE_MEDIA_STATUSES.has(m.status.trim().toLowerCase());
  }
  return true;
};
const extractUrls = (obj) => {
  const raw = Array.isArray(obj.referenceMediaUrls)
    ? obj.referenceMediaUrls
    : Array.isArray(obj.imageUrls)
      ? obj.imageUrls
      : [];
  const deduped = [];
  for (const item of raw) {
    if (!isHttpUrl(item)) continue;
    const clean = item.trim();
    if (!deduped.includes(clean)) deduped.push(clean);
  }
  return deduped;
};
const formatTraits = (traits) =>
  Array.isArray(traits)
    ? traits
    : traits && typeof traits === "object"
      ? Object.entries(traits).map(([k, v]) => `${k}: ${v}`)
      : [];

function parseReferenceDescriptor(ref) {
  if (!ref) return null;
  if (typeof ref === "string") {
    const trimmed = ref.trim();
    if (!trimmed) return null;
    return isHttpUrl(trimmed)
      ? { kind: "url", url: trimmed, name: "Image Reference" }
      : { kind: "auto", id: trimmed };
  }
  if (typeof ref !== "object") return null;

  if ((ref.entityType === "character" || ref.entityType === "element") && ref.name) {
    return { kind: "inline_entity", entity: ref };
  }
  if (typeof ref.url === "string" && isHttpUrl(ref.url)) {
    return { kind: "url", url: ref.url.trim(), name: ref.name || "Image Reference" };
  }

  const explicitType = typeof ref.type === "string" ? ref.type.trim().toLowerCase() : "";
  const charId = typeof (ref.character_id || ref.characterId) === "string"
    ? (ref.character_id || ref.characterId).trim()
    : "";
  if (charId || (explicitType === "character" && typeof ref.id === "string" && ref.id.trim())) {
    return { kind: "character", id: charId || ref.id.trim() };
  }

  const elemId = typeof (ref.element_id || ref.elementId) === "string"
    ? (ref.element_id || ref.elementId).trim()
    : "";
  if (elemId || (explicitType === "element" && typeof ref.id === "string" && ref.id.trim())) {
    return { kind: "element", id: elemId || ref.id.trim() };
  }

  const wfId = typeof (ref.workflow_id || ref.workflowId) === "string"
    ? (ref.workflow_id || ref.workflowId).trim()
    : "";
  if (wfId || (explicitType === "workflow" && typeof ref.id === "string" && ref.id.trim())) {
    return { kind: "workflow", id: wfId || ref.id.trim() };
  }

  const mediaId = typeof (ref.media_id || ref.mediaId) === "string"
    ? (ref.media_id || ref.mediaId).trim()
    : "";
  if (mediaId || (explicitType === "media" && typeof ref.id === "string" && ref.id.trim())) {
    return { kind: "media", id: mediaId || ref.id.trim() };
  }

  const genericId = typeof ref.id === "string" ? ref.id.trim() : "";
  if (genericId) {
    return isHttpUrl(genericId)
      ? { kind: "url", url: genericId, name: ref.name || "Image Reference" }
      : { kind: "auto", id: genericId };
  }

  return null;
}

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
    const getWorkflowPrimaryMediaFn = ctx.getWorkflowPrimaryMedia || getWorkflowPrimaryMedia;
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
    const mediaEntityByUrl = new Map();
    const referenceUrls = [];

    const registerReferenceUrl = (url) => {
      if (!isHttpUrl(url)) return null;
      const cleanUrl = url.trim();
      let idx = referenceUrls.indexOf(cleanUrl);
      if (idx === -1) idx = referenceUrls.push(cleanUrl) - 1;
      return `@image${idx + 1}`;
    };

    const addEntity = (entity, extraAliasIds = []) => {
      if (!entity) return;
      entities.push(entity);
      if (entity.id) entityById.set(String(entity.id), entity);
      if (entity.workflowId) entityById.set(String(entity.workflowId), entity);
      for (const alias of extraAliasIds) {
        if (alias) entityById.set(String(alias), entity);
      }
    };

    const addMediaEntity = (id, url, name = "Image Reference", extraAliasIds = []) => {
      if (!isHttpUrl(url)) return;
      const cleanUrl = url.trim();
      const alreadyRegistered = referenceUrls.includes(cleanUrl);
      registerReferenceUrl(cleanUrl);
      if (alreadyRegistered) {
        const existing = mediaEntityByUrl.get(cleanUrl);
        if (existing) {
          if (id) entityById.set(String(id), existing);
          for (const alias of extraAliasIds) {
            if (alias) entityById.set(String(alias), existing);
          }
        }
        return;
      }
      const entity = {
        id,
        workflowId: id,
        entityType: "media",
        name,
        description: null,
        visualTraits: [],
        imageUrls: [cleanUrl],
      };
      mediaEntityByUrl.set(cleanUrl, entity);
      addEntity(entity, extraAliasIds);
    };

    const addCharacterEntity = (id, src, fallbackName = "Character", extraAliasIds = []) => {
      const urls = extractUrls(src);
      urls.forEach(registerReferenceUrl);
      addEntity(
        {
          id: src.id || id,
          workflowId: src.workflowId || id,
          entityType: "character",
          name: src.name || fallbackName,
          description: src.description || "",
          visualTraits: Array.isArray(src.visualTraits) ? src.visualTraits : formatTraits(src.traits),
          imageUrls: urls,
          sheetImages: Array.isArray(src.sheetImages) ? src.sheetImages : urls,
          detailImages: Array.isArray(src.detailImages) ? src.detailImages : [],
        },
        [id, ...extraAliasIds]
      );
    };

    const addElementEntity = (id, src, extraAliasIds = []) => {
      const urls = extractUrls(src);
      urls.forEach(registerReferenceUrl);
      addEntity(
        {
          id: src.id || id,
          workflowId: src.workflowId || id,
          entityType: "element",
          name: src.name || "Element",
          description: src.description || "",
          visualTraits: Array.isArray(src.visualTraits) ? src.visualTraits : src.guidelines ? [src.guidelines] : [],
          imageUrls: urls,
          sheetImages: [],
          detailImages: urls,
        },
        [id, ...extraAliasIds]
      );
    };

    // 0. Optional single media_id load (direct HTTP URL, media_id, or workflow_id)
    let loadedMediaUrl = null;
    if (typeof inputs.media_id === "string" && inputs.media_id.trim()) {
      const mId = inputs.media_id.trim();
      if (isHttpUrl(mId)) {
        loadedMediaUrl = mId;
        addMediaEntity("source_image", mId, "Source Image");
      } else if (await checkOwnership(["media", "workflow"], mId, { strictFlag: ctx.strictMediaLoad === true })) {
        let record = await getMediaByIdFn(mId).catch(() => null);
        if (!isUsableMediaRecord(record)) {
          const list = await getMediaUrlsFn([mId]).catch(() => []);
          record = Array.isArray(list) ? list.find(isUsableMediaRecord) || null : null;
        }
        if (!isUsableMediaRecord(record)) {
          record = await getWorkflowPrimaryMediaFn(mId).catch(() => null);
        }
        if (isUsableMediaRecord(record)) {
          loadedMediaUrl = record.url.trim();
          addMediaEntity(record.id || record.mediaId || mId, loadedMediaUrl, "Media Reference", [mId]);
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

    // 3. Resolve generic references (URLs, media_id, workflow_id, character_id, element_id)
    const refDescriptorsToLookup = [];
    for (const ref of Array.isArray(inputs.references) ? inputs.references : []) {
      const parsedRef = parseReferenceDescriptor(ref);
      if (!parsedRef) continue;
      if (parsedRef.kind === "inline_entity") {
        extractUrls(parsedRef.entity).forEach(registerReferenceUrl);
        addEntity(parsedRef.entity);
      } else if (parsedRef.kind === "url") {
        addMediaEntity(parsedRef.url, parsedRef.url, parsedRef.name);
      } else {
        refDescriptorsToLookup.push(parsedRef);
      }
    }

    const effectiveLookupUserId = verifyOwnership ? userId : null;

    const tryResolveAsMedia = async (refId) => {
      const mediaRows = await getMediaUrlsFn([refId]).catch(() => []);
      const validRows = Array.isArray(mediaRows) ? mediaRows.filter(isUsableMediaRecord) : [];
      if (validRows.length === 0) return false;
      for (const m of validRows) {
        addMediaEntity(m.mediaId || m.id || refId, m.url, "Image Reference", [refId]);
      }
      return true;
    };

    const tryResolveAsCharacter = async (refId) => {
      const charCtx = await getCharacterFn({ characterId: refId, userId: effectiveLookupUserId }).catch(() => null);
      if (!charCtx || typeof charCtx !== "object") return false;
      addCharacterEntity(refId, charCtx);
      return true;
    };

    const tryResolveAsElement = async (refId) => {
      const elemRes = await getElementFn({ elementIds: [refId], userId: effectiveLookupUserId }).catch(() => null);
      const matched = Array.isArray(elemRes?.elements) ? elemRes.elements : [];
      if (matched.length === 0) return false;
      for (const elem of matched) {
        addElementEntity(elem.id || refId, elem, [refId]);
      }
      return true;
    };

    const tryResolveAsWorkflow = async (refId) => {
      const wfMedia = await getWorkflowPrimaryMediaFn(refId).catch(() => null);
      if (!isUsableMediaRecord(wfMedia)) return false;
      addMediaEntity(refId, wfMedia.url, "Image Reference", [wfMedia.mediaId || wfMedia.id].filter(Boolean));
      return true;
    };

    for (const { kind, id: refId } of refDescriptorsToLookup) {
      if (entityById.has(refId)) continue;

      const ownershipTypes =
        kind === "character"
          ? ["character", "workflow"]
          : kind === "element"
            ? ["element", "workflow"]
            : kind === "workflow"
              ? ["workflow"]
              : kind === "media"
                ? ["media", "workflow"]
                : ["media", "workflow", "character", "element"];

      if (!(await checkOwnership(ownershipTypes, refId))) continue;

      if (kind === "media") {
        await tryResolveAsMedia(refId);
      } else if (kind === "character") {
        await tryResolveAsCharacter(refId);
      } else if (kind === "element") {
        await tryResolveAsElement(refId);
      } else if (kind === "workflow") {
        await tryResolveAsWorkflow(refId);
      } else {
        // Auto-detect untyped ID across media -> character -> element -> workflow
        if (await tryResolveAsMedia(refId)) continue;
        if (await tryResolveAsCharacter(refId)) continue;
        if (await tryResolveAsElement(refId)) continue;
        await tryResolveAsWorkflow(refId);
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
