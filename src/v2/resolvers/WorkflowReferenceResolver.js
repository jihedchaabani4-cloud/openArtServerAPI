/**
 * WorkflowReferenceResolver (Clean Architecture & Repository-Backed)
 *
 * ARCHITECTURE RULES:
 *   - workflow_type in the workflow table is the PRIMARY discriminator.
 *   - Clean repository pattern: all DB access delegates to container `db.*` and `elementRepository`.
 *   - Full entity resolution: character traits, multi-view elements, parent workflow tracing for media.
 *   - Discards unknown references silently with an internal warning (no client error).
 */

import { db } from "../../container.js";
import { elementRepository } from "../../db/ElementRepository.js";
import { createLogger } from "../../infrastructure/logging/index.js";
import { assertOwns, assertOwnsAny } from "../../platform/security/ownership.js";
import { inferWorkflowMediaRole } from "../../db/workflowMediaRole.js";

const dbLogger = createLogger("database");

// ── Known workflow_type constants ─────────────────────────────────────────────
const WORKFLOW_TYPES = Object.freeze({
  CHARACTER_SHEET: "CHARACTER_SHEET",
  ELEMENT_SHEET:   "ELEMENT_SHEET",
  GENERATION:      "GENERATION",
  UPLOAD:          "UPLOAD",
});

// ── Trait and Name Sanitizers ─────────────────────────────────────────────────

function cleanText(val = "") {
  return String(val || "")
    .replace(/<(?:Trait|Tag|Feature|Attribute):\s*([^>]+)>/gi, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanEntityName(name, fallback = "Entity") {
  if (!name || typeof name !== "string") return fallback;
  // Strip only template angle-bracket tags and control chars — preserve Unicode (Arabic, French, etc.)
  const cleaned = cleanText(name).replace(/[<>{}|\x00-\x1F\x7F]/g, "").replace(/\s+/g, " ").trim();
  return cleaned || fallback;
}

/**
 * Extracts compact visual keywords/tags only.
 * Description is intentionally excluded — it's stored separately on the entity object.
 */
function extractTraits(entity, specificKeys = []) {
  const traits = [];

  for (const key of specificKeys) {
    if (entity[key] && typeof entity[key] === "string") {
      traits.push(`${key}: ${cleanText(entity[key])}`);
    }
  }

  // Object traits map (e.g. traits: { hair: "silver", eyes: "cyan" })
  if (entity.traits && typeof entity.traits === "object" && !Array.isArray(entity.traits)) {
    for (const [k, v] of Object.entries(entity.traits)) {
      if (!v) continue;
      const key = k.toLowerCase();
      const val = cleanText(v);
      if (["hair", "eyes", "skin"].includes(key))      traits.push(`${val} ${key}`);
      else if (["outfit", "clothing"].includes(key))   traits.push(`wearing ${val}`);
      else                                              traits.push(`${key}: ${val}`);
    }
  }

  // Flat array trait sources: keywords, tags, visualTraits, guidelines, features
  for (const arrKey of ["traits", "keywords", "tags", "visualTraits", "guidelines", "features"]) {
    if (Array.isArray(entity[arrKey])) {
      for (const item of entity[arrKey]) {
        const cleaned = cleanText(item);
        if (cleaned) traits.push(cleaned);
      }
    }
  }

  return [...new Set(traits.filter(Boolean))];
}

// ── Entity Resolvers ──────────────────────────────────────────────────────────

export async function resolveAsCharacter(workflowId, userId = null) {
  try {
    if (userId) {
      try {
        await assertOwns("character", workflowId, userId);
      } catch {
        return null;
      }
    }

    const char = await db.characters.findByCharacterId(workflowId);
    if (!char) return null;

    const sheetUrls = new Set();
    const detailUrls = new Set();

    // Resolve linked media rows from MediaRepository (canonical source of truth)
    const charWfId = char.workflow_id || char.id || workflowId;
    if (charWfId) {
      const mediaList = await db.media.findByWorkflow(charWfId).catch(() => []);
      if (Array.isArray(mediaList)) {
        for (const m of mediaList) {
          if (m?.url && typeof m.url === "string" && m.url.startsWith("http")) {
            const cleanUrl = m.url.trim();
            const mediaRole = inferWorkflowMediaRole({
              role: m.mediaRole || m.role,
              stepId: m.step_id,
              workflowType: WORKFLOW_TYPES.CHARACTER_SHEET,
            });
            if (mediaRole === "detail") {
              detailUrls.add(cleanUrl);
            } else {
              sheetUrls.add(cleanUrl);
            }
          }
        }
      }
    }

    const allUrls = [...new Set([...sheetUrls, ...detailUrls])].filter(Boolean);

    return {
      workflowId,
      entityType:    "character",
      entityId:      char.id || workflowId,
      name:          cleanEntityName(char.name || char.title, "Character"),
      description:   char.description || char.character_info || null,
      // "style" excluded — it's a workflow-level setting handled separately as prompt suffix, not a visual trait.
      visualTraits:  extractTraits(char, ["archetype", "gender"]),
      imageUrls:     allUrls,
      sheetImages:   [...sheetUrls].filter(Boolean),
      detailImages:  [...detailUrls].filter(Boolean),
      referenceTags: [],
      sheetTags:     [],
      detailTags:    [],
    };
  } catch (err) {
    dbLogger.warn({ workflowId, message: err.message }, "character resolve failed");
    return null;
  }
}

export async function resolveAsElement(workflowId, userId = null) {
  try {
    if (userId) {
      try {
        await assertOwns("element", workflowId, userId);
      } catch {
        return null;
      }
    }

    const elem = await elementRepository.resolveRecord(workflowId);
    if (!elem) return null;

    const urls = new Set();
    const directFields = ["image_url", "cover_url", "avatar_url", "primary_image_url"];

    for (const f of directFields) {
      if (elem[f] && typeof elem[f] === "string" && elem[f].startsWith("http")) {
        urls.add(elem[f].trim());
      }
    }

    // Resolve source_images array (URLs or media IDs) in parallel
    const mediaIdLookups = [];
    for (const arr of ["source_images", "references"]) {
      if (Array.isArray(elem[arr])) {
        for (const r of elem[arr]) {
          if (typeof r === "string" && r.startsWith("http")) {
            urls.add(r.trim());
          } else if (typeof r === "string" && r.trim().length > 10) {
            mediaIdLookups.push(r.trim());
          }
        }
      }
    }

    if (mediaIdLookups.length > 0) {
      const mediaResults = await Promise.all(
        [...new Set(mediaIdLookups)].map((id) => db.media.findMediaByIdOrWorkflow(id).catch(() => null))
      );
      for (const m of mediaResults) {
        if (m?.url && typeof m.url === "string" && m.url.startsWith("http")) {
          urls.add(m.url.trim());
        }
      }
    }

    // Resolve linked media rows from MediaRepository
    const elemWfId = elem.workflow_id || elem.id || workflowId;
    if (elemWfId) {
      const mediaList = await db.media.findByWorkflow(elemWfId).catch(() => []);
      if (Array.isArray(mediaList)) {
        for (const m of mediaList) {
          if (m?.url && typeof m.url === "string" && m.url.startsWith("http")) {
            urls.add(m.url.trim());
          }
        }
      }
    }

    return {
      workflowId,
      entityType:    "element",
      entityId:      elem.id || workflowId,
      name:          cleanEntityName(elem.name, "Element"),
      description:   elem.description || null,
      visualTraits:  extractTraits(elem, ["element_type"]),
      imageUrls:     [...urls].filter(Boolean),
      referenceTags: [],
    };
  } catch (err) {
    dbLogger.warn({ workflowId, message: err.message }, "element resolve failed");
    return null;
  }
}

export async function resolveAsMedia(workflowId, userId = null) {
  try {
    if (userId) {
      try {
        await assertOwnsAny(["workflow", "media"], workflowId, userId);
      } catch {
        return null;
      }
    }

    const media = await db.media.findMediaByIdOrWorkflow(workflowId);
    if (!media) return null;

    // Check if this media row belongs to a parent Character or Element workflow
    if (media.workflow_id && media.workflow_id !== media.id) {
      const parentWf = await db.workflows.findById(media.workflow_id).catch(() => null);
      if (parentWf?.workflow_type === WORKFLOW_TYPES.CHARACTER_SHEET) {
        const char = await resolveAsCharacter(parentWf.id, userId);
        if (char) return char;
      }
      if (parentWf?.workflow_type === WORKFLOW_TYPES.ELEMENT_SHEET) {
        const elem = await resolveAsElement(parentWf.id, userId);
        if (elem) return elem;
      }
    }

    return {
      workflowId:    media.workflow_id || workflowId,
      entityType:    "media",
      entityId:      media.id || workflowId,
      name:          media.display_name || media.name || "Image Reference",
      description:   null,
      visualTraits:  [],
      imageUrls:     media.url ? [media.url] : [],
      referenceTags: [],
    };
  } catch (err) {
    dbLogger.warn({ workflowId, message: err.message }, "media resolve failed");
    return null;
  }
}

// ── Main Resolver ─────────────────────────────────────────────────────────────

/**
 * Resolves a single workflow_id / entity_id to a complete ResolvedReference.
 *
 * Flow:
 *   1. Direct URL check.
 *   2. Primary path: Lookup workflow_type in workflow repository.
 *   3. Secondary path: Entity repository fallbacks (character -> element -> media).
 */
export async function resolveWorkflowReference(workflowId, userId = null) {
  if (!workflowId || typeof workflowId !== "string") return null;
  const id = workflowId.trim();

  // 1. Direct HTTP URLs are rejected — caller must pass workflow IDs only
  if (id.startsWith("http://") || id.startsWith("https://")) {
    dbLogger.warn({ workflowId: id.slice(0, 60) }, "Direct URL rejected; callers must pass workflow IDs");
    return null;
  }

  // 2. Primary Path: Query workflow table via repository
  try {
    const wf = await db.workflows.findById(id).catch(() => null);
    if (wf?.workflow_type) {
      if (userId) {
        try {
          await assertOwns("workflow", id, userId);
        } catch {
          return null;
        }
      }
      switch (wf.workflow_type) {
        case WORKFLOW_TYPES.CHARACTER_SHEET:
          return resolveAsCharacter(id, userId);
        case WORKFLOW_TYPES.ELEMENT_SHEET:
          return resolveAsElement(id, userId);
        case WORKFLOW_TYPES.GENERATION:
        case WORKFLOW_TYPES.UPLOAD:
          return resolveAsMedia(id, userId);
        default:
          dbLogger.warn({ workflowId: id, workflowType: wf.workflow_type }, "unsupported workflow_type");
          return null;
      }
    }
  } catch (err) {
    dbLogger.warn({ workflowId: id, message: err.message }, "workflow lookup error");
  }

  // 3. Fallback: Entity table resolution (if ID is direct entity/media PK)
  dbLogger.warn({ workflowId: id }, "not in workflow table; trying entity tables");

  const [charResult, elemResult, mediaResult] = await Promise.allSettled([
    resolveAsCharacter(id, userId),
    resolveAsElement(id, userId),
    resolveAsMedia(id, userId),
  ]);

  if (charResult.status === "fulfilled" && charResult.value) return charResult.value;
  if (elemResult.status  === "fulfilled" && elemResult.value)  return elemResult.value;
  if (mediaResult.status === "fulfilled" && mediaResult.value) return mediaResult.value;

  dbLogger.warn({ workflowId: id }, "not found in any entity table; discarded");
  return null;
}

/**
 * Resolves multiple workflow_ids in parallel.
 */
export async function resolveWorkflowReferences(workflowIds = [], userId = null) {
  const unique = [...new Set(workflowIds.filter(id => id && typeof id === "string"))];
  const results = await Promise.all(unique.map(id => resolveWorkflowReference(id, userId)));
  return results.filter(Boolean);
}

/**
 * Resolves the PRIMARY media URL for a workflow.
 *
 * This is the canonical function to get the image URL of a GENERATION workflow
 * when we want to use it as an edit source target.
 *
 * Resolution order (via WorkflowRepository.getPrimaryMedia):
 *   1. workflow.primary_media_id → media.url  (explicit user selection)
 *   2. First created media for this workflow   (fallback for workflows without primary set)
 *
 * NEVER uses "latest by create_time desc" — that would return an edited version
 * instead of the one the user selected.
 *
 * @param {string} workflowId
 * @param {string} [userId]
 * @returns {Promise<string|null>} the resolved image URL or null
 */
export async function resolvePrimaryMediaUrl(workflowId, userId = null) {
  if (!workflowId || typeof workflowId !== "string") return null;

  if (userId) {
    try {
      await assertOwnsAny(["workflow", "media"], workflowId, userId);
    } catch (err) {
      dbLogger.warn({ workflowId, userId }, `resolvePrimaryMediaUrl: ownership check failed: ${err.message}`);
      return null;
    }
  }

  try {
    const url = await db.workflows.getPrimaryMediaUrl(workflowId);
    if (url) {
      dbLogger.debug({ workflowId, url }, `resolvePrimaryMediaUrl "${workflowId}" resolved`);
      return url;
    }
    // Fallback: if workflowId is a direct media ID, check db.media
    if (db.media?.findMediaByIdOrWorkflow) {
      const media = await db.media.findMediaByIdOrWorkflow(workflowId).catch(() => null);
      if (media?.url) {
        dbLogger.debug({ workflowId, url: media.url }, `resolvePrimaryMediaUrl "${workflowId}" resolved via media table`);
        return media.url;
      }
    }
    dbLogger.warn({ workflowId }, `resolvePrimaryMediaUrl "${workflowId}": no URL found on primary media`);
    return null;
  } catch (err) {
    dbLogger.warn({ workflowId, err }, `resolvePrimaryMediaUrl "${workflowId}" error: ${err.message}`);
    return null;
  }
}

export default resolveWorkflowReference;
