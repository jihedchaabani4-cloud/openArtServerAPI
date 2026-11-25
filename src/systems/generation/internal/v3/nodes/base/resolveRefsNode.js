import { getCharacterPromptContext } from "#characters/tools";
import { getElementPromptContext } from "#elements/tools";
import { getMediaById, getMediaUrls, getWorkflowPrimaryMedia } from "#media/tools";
import { assertOwns, assertOwnsAny } from "#identity/tools";
import { GenerationError } from "../../../errors.js";

const INLINE_TAG_REGEX = /<(character|element):([^>\s]+)>/gi;
const VIDEO_EXTENSION_REGEX = /\.(?:mp4|webm|mov|m4v)(?:$|[?#])/i;
const INACTIVE_MEDIA_STATUSES = new Set(["failed", "saved", "processing", "pending", "queued", "uploading", "in_progress", "starting"]);

export function normalizeAllowedMediaTypes(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const normalized = raw
    .map((t) => (typeof t === "string" ? t.trim().toLowerCase() : ""))
    .filter(Boolean);
  return normalized.length > 0 ? new Set(normalized) : null;
}

export function inferMediaType({
  url = "",
  mimeType = null,
  mime_type = null,
  stepId = null,
  step_id = null,
  mediaType = null,
  media_type = null,
} = {}) {
  const explicitType = String(mediaType || media_type || "").trim().toLowerCase();
  if (explicitType === "video" || explicitType === "image" || explicitType === "audio") {
    return explicitType;
  }

  const mime = String(mimeType || mime_type || "").trim().toLowerCase();
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";

  const step = String(stepId || step_id || "").trim().toLowerCase();
  if (step === "video_generation" || step.startsWith("video_")) return "video";

  if (typeof url === "string" && url.trim()) {
    const trimmed = url.trim();
    try {
      const pathname = new URL(trimmed).pathname;
      if (VIDEO_EXTENSION_REGEX.test(pathname)) return "video";
    } catch {
      if (VIDEO_EXTENSION_REGEX.test(trimmed)) return "video";
    }
  }

  return "image";
}

function toUnsupportedMediaTypeError({ detectedType, allowedTypes, resourceId = null, url = null }) {
  const allowedList = [...allowedTypes].join(", ");
  return new GenerationError({
    code: "UNSUPPORTED_MEDIA_TYPE",
    message: `Unsupported media type "${detectedType}"${resourceId ? ` for resource "${resourceId}"` : ""}. Allowed media types: ${allowedList}.`,
    userMessage: `This workflow only supports ${allowedList} media.`,
    status: 400,
    statusCode: 400,
    category: "USER_FAULT",
    retryable: false,
    billingAction: "REFUND_HOLD",
    isInternal: false,
    context: {
      detectedType,
      allowedMediaTypes: [...allowedTypes],
      ...(resourceId ? { resourceId } : {}),
      ...(url ? { url } : {}),
    },
  });
}

export function assertAllowedMediaType(mediaInfo, allowedMediaTypes, resourceId = null) {
  const allowedSet =
    allowedMediaTypes instanceof Set ? allowedMediaTypes : normalizeAllowedMediaTypes(allowedMediaTypes);
  if (!allowedSet) return;
  const info = typeof mediaInfo === "string" ? { url: mediaInfo } : (mediaInfo || {});
  const detectedType = inferMediaType(info);
  if (!allowedSet.has(detectedType)) {
    throw toUnsupportedMediaTypeError({
      detectedType,
      allowedTypes: allowedSet,
      resourceId,
      url: typeof info.url === "string" ? info.url.trim() : null,
    });
  }
}

function isProbeMissError(err) {
  if (!err) return true;
  const status = Number(err.statusCode || err.status || 0);
  const code = String(err.code || err.errorCode || "").toUpperCase();
  if (status >= 500) return false;
  if (
    status === 404 ||
    status === 403 ||
    status === 400 ||
    code.includes("NOT_FOUND") ||
    code.includes("UNAUTHORIZED") ||
    code.includes("FORBIDDEN")
  ) {
    return true;
  }
  return /not found|does not exist|not a (character|element)/i.test(String(err.message || ""));
}
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
      allowedMediaTypes: { type: "ARRAY" },
      maxReferences: { type: "INT" },
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
    const allowedMediaTypeSet = normalizeAllowedMediaTypes(inputs.allowedMediaTypes);
    const rawMaxRefs = Number(inputs.maxReferences);
    const maxReferences = Number.isInteger(rawMaxRefs) && rawMaxRefs >= 1 ? rawMaxRefs : null;
    const effectiveLookupUserId = verifyOwnership ? userId : null;

    const assertMediaAllowed = (mediaInfo, resourceId = null) => {
      assertAllowedMediaType(mediaInfo, allowedMediaTypeSet, resourceId);
    };

    const registerReferenceUrl = (url) => {
      if (!isHttpUrl(url)) return null;
      const cleanUrl = url.trim();
      let idx = referenceUrls.indexOf(cleanUrl);
      if (idx === -1) {
        if (maxReferences !== null && referenceUrls.length >= maxReferences) {
          return null;
        }
        idx = referenceUrls.push(cleanUrl) - 1;
      }
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

    const addMediaEntity = (id, url, name = "Image Reference", extraAliasIds = [], mediaMeta = null) => {
      if (!isHttpUrl(url)) return;
      const cleanUrl = url.trim();
      assertMediaAllowed({ ...(mediaMeta && typeof mediaMeta === "object" ? mediaMeta : {}), url: cleanUrl }, id);
      const alreadyRegistered = referenceUrls.includes(cleanUrl);
      const tag = registerReferenceUrl(cleanUrl);
      if (!tag) return;
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

    const registerEntityUrls = (rawUrls, resourceId) => {
      const kept = [];
      for (const url of rawUrls) {
        assertMediaAllowed({ url }, resourceId);
        if (registerReferenceUrl(url)) {
          kept.push(url);
        }
      }
      return kept;
    };

    const addCharacterEntity = (id, src, fallbackName = "Character", extraAliasIds = []) => {
      const urls = registerEntityUrls(extractUrls(src), src.id || id);
      addEntity(
        {
          id: src.id || id,
          workflowId: src.workflowId || id,
          entityType: "character",
          name: src.name || fallbackName,
          description: src.description || "",
          visualTraits: Array.isArray(src.visualTraits) ? src.visualTraits : formatTraits(src.traits),
          imageUrls: urls,
          sheetImages: Array.isArray(src.sheetImages) ? src.sheetImages.filter((u) => urls.includes(u)) : urls,
          detailImages: Array.isArray(src.detailImages) ? src.detailImages.filter((u) => urls.includes(u)) : [],
        },
        [id, ...extraAliasIds]
      );
    };

    const addElementEntity = (id, src, extraAliasIds = []) => {
      const urls = registerEntityUrls(extractUrls(src), src.id || id);
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
        let record = await getMediaByIdFn(mId).catch((err) => {
          if (isProbeMissError(err)) return null;
          throw err;
        });
        if (!isUsableMediaRecord(record)) {
          const list = await getMediaUrlsFn([mId]).catch((err) => {
            if (isProbeMissError(err)) return [];
            throw err;
          });
          record = Array.isArray(list) ? list.find(isUsableMediaRecord) || null : null;
        }
        if (!isUsableMediaRecord(record)) {
          record = await getWorkflowPrimaryMediaFn(mId).catch((err) => {
            if (isProbeMissError(err)) return null;
            throw err;
          });
        }
        if (isUsableMediaRecord(record)) {
          loadedMediaUrl = record.url.trim();
          addMediaEntity(record.id || record.mediaId || mId, loadedMediaUrl, "Media Reference", [mId], record);
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
      const charCtx = await getCharacterFn({ characterId: charId, userId: effectiveLookupUserId });
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
        const elemResult = await getElementFn({ elementIds: verifiedElemIds, userId: effectiveLookupUserId });
        for (const elem of elemResult?.elements || []) addElementEntity(elem.id, elem);
      }
    }

    // 3. Resolve generic references (URLs, media_id, workflow_id, character_id, element_id)
    const refDescriptorsToLookup = [];
    for (const ref of Array.isArray(inputs.references) ? inputs.references : []) {
      const parsedRef = parseReferenceDescriptor(ref);
      if (!parsedRef) continue;
      if (parsedRef.kind === "inline_entity") {
        const keptUrls = registerEntityUrls(
          extractUrls(parsedRef.entity),
          parsedRef.entity.id || parsedRef.entity.name || null
        );
        addEntity({ ...parsedRef.entity, imageUrls: keptUrls });
      } else if (parsedRef.kind === "url") {
        addMediaEntity(parsedRef.url, parsedRef.url, parsedRef.name, [], typeof ref === "object" ? ref : null);
      } else {
        refDescriptorsToLookup.push(parsedRef);
      }
    }

    // Deduplicate pending descriptors before ownership + parallel lookup
    const uniquePendingRefs = [];
    const seenPendingIds = new Set();
    for (const desc of refDescriptorsToLookup) {
      if (entityById.has(desc.id) || seenPendingIds.has(desc.id)) continue;
      seenPendingIds.add(desc.id);
      uniquePendingRefs.push(desc);
    }

    // Ownership checks (parallel when relaxed; sequential when strictOwnership so first error is deterministic)
    const verifiedRefs = [];
    for (const desc of uniquePendingRefs) {
      const ownershipTypes =
        desc.kind === "character"
          ? ["character", "workflow"]
          : desc.kind === "element"
            ? ["element", "workflow"]
            : desc.kind === "workflow"
              ? ["workflow"]
              : desc.kind === "media"
                ? ["media", "workflow"]
                : ["media", "workflow", "character", "element"];
      if (await checkOwnership(ownershipTypes, desc.id)) {
        verifiedRefs.push(desc);
      }
    }

    // Single batched media lookup for all media/auto IDs to eliminate N+1 media round-trips
    const mediaBatchIds = verifiedRefs
      .filter((d) => d.kind === "media" || d.kind === "auto")
      .map((d) => d.id);
    const mediaByIdMap = new Map();
    if (mediaBatchIds.length > 0) {
      const batchRows = await getMediaUrlsFn(mediaBatchIds).catch((err) => {
        if (isProbeMissError(err)) return [];
        throw err;
      });
      for (const m of Array.isArray(batchRows) ? batchRows : []) {
        if (!isUsableMediaRecord(m)) continue;
        const key = String(m.mediaId || m.id || (mediaBatchIds.length === 1 ? mediaBatchIds[0] : ""));
        if (key) {
          if (!mediaByIdMap.has(key)) mediaByIdMap.set(key, []);
          mediaByIdMap.get(key).push(m);
        }
      }
    }

    const resolveSingleRef = async ({ kind, id: refId }) => {
      if (kind === "media") {
        const rows = mediaByIdMap.get(refId) || [];
        return rows.length > 0 ? { resolvedKind: "media", refId, rows } : null;
      }

      if (kind === "character") {
        const charCtx = await getCharacterFn({ characterId: refId, userId: null }).catch((err) => {
          if (isProbeMissError(err)) return null;
          throw err;
        });
        return charCtx && typeof charCtx === "object" ? { resolvedKind: "character", refId, charCtx } : null;
      }

      if (kind === "element") {
        const elemRes = await getElementFn({ elementIds: [refId], userId: null }).catch((err) => {
          if (isProbeMissError(err)) return null;
          throw err;
        });
        const matched = Array.isArray(elemRes?.elements) ? elemRes.elements : [];
        return matched.length > 0 ? { resolvedKind: "element", refId, elements: matched } : null;
      }

      if (kind === "workflow") {
        const wfMedia = await getWorkflowPrimaryMediaFn(refId);
        return isUsableMediaRecord(wfMedia) ? { resolvedKind: "workflow", refId, wfMedia } : null;
      }

      // kind === "auto": media (already batched) -> character -> element -> workflow
      const batchedMedia = mediaByIdMap.get(refId);
      if (batchedMedia && batchedMedia.length > 0) {
        return { resolvedKind: "media", refId, rows: batchedMedia };
      }

      const charCtx = await getCharacterFn({ characterId: refId, userId: null }).catch((err) => {
        if (isProbeMissError(err)) return null;
        throw err;
      });
      if (charCtx && typeof charCtx === "object") {
        return { resolvedKind: "character", refId, charCtx };
      }

      const elemRes = await getElementFn({ elementIds: [refId], userId: null }).catch((err) => {
        if (isProbeMissError(err)) return null;
        throw err;
      });
      const matchedElements = Array.isArray(elemRes?.elements) ? elemRes.elements : [];
      if (matchedElements.length > 0) {
        return { resolvedKind: "element", refId, elements: matchedElements };
      }

      const wfMedia = await getWorkflowPrimaryMediaFn(refId);
      if (isUsableMediaRecord(wfMedia)) {
        return { resolvedKind: "workflow", refId, wfMedia };
      }

      return null;
    };

    // Resolve all verified refs in parallel while registering results in deterministic input order
    const resolvedRefResults = await Promise.all(verifiedRefs.map(resolveSingleRef));
    for (const outcome of resolvedRefResults) {
      if (!outcome || entityById.has(outcome.refId)) continue;
      if (outcome.resolvedKind === "media") {
        for (const m of outcome.rows) {
          addMediaEntity(m.mediaId || m.id || outcome.refId, m.url, "Image Reference", [outcome.refId], m);
        }
      } else if (outcome.resolvedKind === "character") {
        addCharacterEntity(outcome.refId, outcome.charCtx);
      } else if (outcome.resolvedKind === "element") {
        for (const elem of outcome.elements) {
          addElementEntity(elem.id || outcome.refId, elem, [outcome.refId]);
        }
      } else if (outcome.resolvedKind === "workflow") {
        addMediaEntity(
          outcome.refId,
          outcome.wfMedia.url,
          "Image Reference",
          [outcome.wfMedia.mediaId || outcome.wfMedia.id].filter(Boolean),
          outcome.wfMedia
        );
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
