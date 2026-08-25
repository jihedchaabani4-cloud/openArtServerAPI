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

// ── Known workflow_type constants ─────────────────────────────────────────────
const WORKFLOW_TYPES = Object.freeze({
  CHARACTER_SHEET: "CHARACTER_SHEET",
  ELEMENT_SHEET:   "ELEMENT_SHEET",
  GENERATION:      "GENERATION",
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

export async function resolveAsCharacter(workflowId) {
  try {
    const char = await db.characters.findByCharacterId(workflowId);
    if (!char) return null;

    const sheetUrls = new Set();
    const detailUrls = new Set();

    // Priority-ordered direct fields — take the FIRST valid one only to avoid redundant sheet images.
    // The media table (below) is the canonical source for all actual turnaround/detail images.
    const prioritySheetFields = [
      "turnaround_url", "body_sheet_url", "sheet_url",
      "avatar_url", "primary_image_url", "image_url", "cover_url"
    ];
    for (const f of prioritySheetFields) {
      if (char[f] && typeof char[f] === "string" && char[f].startsWith("http")) {
        sheetUrls.add(char[f].trim());
        break; // ← first valid field wins; media table fills the rest
      }
    }

    // Resolve linked media rows from MediaRepository
    const charWfId = char.workflow_id || char.id || workflowId;
    if (charWfId) {
      const mediaList = await db.media.findByWorkflow(charWfId).catch(() => []);
      if (Array.isArray(mediaList)) {
        for (const m of mediaList) {
          if (m?.url && typeof m.url === "string" && m.url.startsWith("http")) {
            const cleanUrl = m.url.trim();
            if (m.step_id === "character_detail") {
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
    console.warn(`[WorkflowReferenceResolver] character resolve failed for ${workflowId}:`, err.message);
    return null;
  }
}

export async function resolveAsElement(workflowId) {
  try {
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
    console.warn(`[WorkflowReferenceResolver] element resolve failed for ${workflowId}:`, err.message);
    return null;
  }
}

export async function resolveAsMedia(workflowId) {
  try {
    const media = await db.media.findMediaByIdOrWorkflow(workflowId);
    if (!media) return null;

    // Check if this media row belongs to a parent Character or Element workflow
    if (media.workflow_id && media.workflow_id !== media.id) {
      const parentWf = await db.workflows.findById(media.workflow_id).catch(() => null);
      if (parentWf?.workflow_type === WORKFLOW_TYPES.CHARACTER_SHEET) {
        const char = await resolveAsCharacter(parentWf.id);
        if (char) return char;
      }
      if (parentWf?.workflow_type === WORKFLOW_TYPES.ELEMENT_SHEET) {
        const elem = await resolveAsElement(parentWf.id);
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
    console.warn(`[WorkflowReferenceResolver] media resolve failed for ${workflowId}:`, err.message);
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
export async function resolveWorkflowReference(workflowId) {
  if (!workflowId || typeof workflowId !== "string") return null;
  const id = workflowId.trim();

  // 1. Direct HTTP URL
  if (id.startsWith("http://") || id.startsWith("https://")) {
    return {
      workflowId:   id,
      entityType:   "media",
      entityId:     id,
      name:         "Image Reference",
      description:  null,
      visualTraits: [],
      imageUrls:    [id],
      referenceTags: [],
    };
  }

  // 2. Primary Path: Query workflow table via repository
  try {
    const wf = await db.workflows.findById(id).catch(() => null);
    if (wf?.workflow_type) {
      switch (wf.workflow_type) {
        case WORKFLOW_TYPES.CHARACTER_SHEET:
          return resolveAsCharacter(id);
        case WORKFLOW_TYPES.ELEMENT_SHEET:
          return resolveAsElement(id);
        case WORKFLOW_TYPES.GENERATION:
          return resolveAsMedia(id);
        default:
          console.warn(`[WorkflowReferenceResolver] unsupported workflow_type "${wf.workflow_type}" for ${id}`);
          return null;
      }
    }
  } catch (err) {
    console.warn(`[WorkflowReferenceResolver] workflow lookup error for ${id}:`, err.message);
  }

  // 3. Fallback: Entity table resolution (if ID is direct entity/media PK)
  console.warn(`[WorkflowReferenceResolver] "${id}" not in workflow table — trying entity tables`);

  const [charResult, elemResult, mediaResult] = await Promise.allSettled([
    resolveAsCharacter(id),
    resolveAsElement(id),
    resolveAsMedia(id),
  ]);

  if (charResult.status === "fulfilled" && charResult.value) return charResult.value;
  if (elemResult.status  === "fulfilled" && elemResult.value)  return elemResult.value;
  if (mediaResult.status === "fulfilled" && mediaResult.value) return mediaResult.value;

  console.warn(`[WorkflowReferenceResolver] "${id}" not found in any entity table — discarded`);
  return null;
}

/**
 * Resolves multiple workflow_ids in parallel.
 */
export async function resolveWorkflowReferences(workflowIds = []) {
  const unique = [...new Set(workflowIds.filter(id => id && typeof id === "string"))];
  const results = await Promise.all(unique.map(id => resolveWorkflowReference(id)));
  return results.filter(Boolean);
}

export default resolveWorkflowReference;
