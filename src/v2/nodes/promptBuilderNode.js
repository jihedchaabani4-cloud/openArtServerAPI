/**
 * Prompt Builder Node (V2 — Clean & Production-Ready)
 * LLM calls: 0 | DB calls: via WorkflowReferenceResolver
 *
 * Contract:
 *   IN  → prompt: string, references: [{ workflow_id }], style?: string
 *   OUT → { finalPrompt: string, context: WorkflowContext }
 *
 * What it does (in order):
 *   1. Validate & sanitize inputs via NodeSafetyService
 *   2. Resolve ONLY references[] from DB (inline tags are positional markers, NOT fetch requests)
 *   3. Build entityMap for O(1) tag-to-entity lookup
 *   4. Assign @imageN to all entity images in references[] natural order
 *   5. Format prompt: replace <type:uuid> tags with @Name or @imageN (unknown IDs removed silently)
 *   6. Build clean top prompt: @Tags + user text + style (no description duplication)
 *   7. Append [Reference Guide] block: structured entity cards with description + traits + image refs
 *   8. Return finalPrompt + full context (imageUrls, referenceGuide, entities)
 */

import { NodeSafetyService } from "./safety/NodeSafetyService.js";
import { resolveWorkflowReferences } from "../resolvers/WorkflowReferenceResolver.js";

// ─────────────────────────────────────────────────────────────────────────────
// NOTE: Inline tags like <character:uuid> in the prompt are POSITIONAL MARKERS only.
// They tell the formatter WHERE to place an entity — they are NOT resolution requests.
// Resolution always comes exclusively from references[] sent by the frontend.
// If a tag's ID is not found in the resolved entityMap → it is removed from the prompt.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// 2. Image Registry — global ordered URL list, assigns sequential @imageN numbers
// ─────────────────────────────────────────────────────────────────────────────
function makeImageRegistry() {
  const urls = [];
  return {
    register(url) {
      if (!url || typeof url !== "string" || !url.trim().startsWith("http")) return null;
      const clean = url.trim();
      let idx = urls.indexOf(clean);
      if (idx === -1) { urls.push(clean); idx = urls.length - 1; }
      return idx + 1; // 1-based
    },
    all: urls,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Entity Image Tagger — assigns @imageN tags per entity
//    Characters: separates sheetImages (turnaround) from detailImages (closeups)
//    Elements & Media: flat imageUrls
// ─────────────────────────────────────────────────────────────────────────────
function tagEntityImages(entities = [], registry, idToIndexMap) {
  for (const entity of entities) {
    const sheetTags  = [];
    const detailTags = [];
    const allTags    = [];

    const addTag = (url, target) => {
      const n = registry.register(url);
      if (!n) return;
      const tag = `@image${n}`;
      if (!allTags.includes(tag)) allTags.push(tag);
      if (!target.includes(tag))  target.push(tag);
    };

    if (entity.entityType === "character") {
      // Character: categorized images (sheet turnaround + detail closeups)
      for (const url of Array.isArray(entity.sheetImages) ? entity.sheetImages : []) addTag(url, sheetTags);
      for (const url of Array.isArray(entity.detailImages) ? entity.detailImages : []) addTag(url, detailTags);
    } else {
      // Element / Media: flat image list
      for (const url of Array.isArray(entity.imageUrls) ? entity.imageUrls : []) addTag(url, allTags);
    }

    entity.sheetTags  = sheetTags;
    entity.detailTags = detailTags;
    entity.referenceTags = allTags;

    if (allTags.length > 0) {
      const first = parseInt(allTags[0].replace("@image", ""), 10);
      idToIndexMap.set(entity.workflowId, first);
      if (entity.entityId) idToIndexMap.set(entity.entityId, first);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Prompt Formatter — replaces inline <type:id> tags with @Name or @imageN
// ─────────────────────────────────────────────────────────────────────────────
function formatPrompt(rawPrompt = "", entityMap, idToIndexMap) {
  if (typeof rawPrompt !== "string") return "";
  return rawPrompt
    // 1. Unwrap display-only tags: <Trait:X> → X
    .replace(/<(?:Trait|Tag|Feature|Attribute):\s*([^>]+)>/gi, "$1")
    // 2. Replace entity/media tags with @Name or @imageN
    //    If ID is not in entityMap (not declared in references[]) → remove silently
    .replace(/<(?:character|element|MediaAsset|media|ref|reference):\s*([^>]+)>/gi, (_, rawId) => {
      const id = rawId.trim();
      const entity = entityMap.get(id);

      if (!entity) return ""; // Not in references[] → remove from prompt

      if (entity.entityType === "character" || entity.entityType === "element") {
        return `@${entity.name}`;
      }

      const n = idToIndexMap.get(id);
      return n !== undefined ? `@image${n}` : "";
    })
    // 3. Strip remaining unrecognised tags — only <Word...> patterns, NOT math operators like <5 or >3
    .replace(/<\w[^>]*>/g, "")
    // 4. Cleanup trailing, leading, or duplicated commas & spaces left by stripped tags
    .replace(/\s+,/g, ",")
    .replace(/,\s*,+/g, ",")
    .replace(/^[\s,;]+/g, "")
    .replace(/[\s,;]+$/g, "")
    .replace(/\s+(?:and|or|with)\s*$/gi, "")
    .replace(/,\s*([.!?])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Reference Guide Card Builder — structured card per entity for the model
// ─────────────────────────────────────────────────────────────────────────────
function buildGuideLine(entity) {
  const { name, entityType, description, visualTraits = [], referenceTags = [], sheetTags = [], detailTags = [] } = entity;

  if (referenceTags.length === 0 && !description) return null;

  if (entityType === "media") {
    return `${name} (image reference) — ${referenceTags[0] || "@image1"}`;
  }

  const label = `@${name} (${entityType})`;
  const lines = [label];

  if (description) {
    lines.push(`  description: ${description.trim().replace(/\.$/, "")}`);
  }
  if (visualTraits.length > 0) {
    lines.push(`  traits: ${visualTraits.join(", ")}`);
  }

  if (detailTags.length > 0) {
    const parts = [];
    if (sheetTags.length > 0) parts.push(`turnaround sheet: ${sheetTags.join(", ")}`);
    parts.push(`detail closeups: ${detailTags.join(", ")}`);
    lines.push(`  visual references: ${parts.join(" | ")}`);
  } else if (referenceTags.length > 0) {
    lines.push(`  visual references: ${referenceTags.join(", ")}`);
  }

  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXECUTION
// ─────────────────────────────────────────────────────────────────────────────
export async function executePromptBuilder(resolvedInputs, ctx = {}) {
  const { nodeId = "prompt-builder", runId = "run-1", userId = "usr-1" } = ctx;

  // ── Step 1: Validate inputs ───────────────────────────────────────────────
  const safe = NodeSafetyService.assertPromptBuilderInputs(resolvedInputs, nodeId);
  let rawPrompt = safe.prompt || "";

  // ── Normalize in-memory entities if provided ──────────────────────────────
  const inputCharacters = (Array.isArray(safe.characters) ? safe.characters : []).map((c, index) => {
    if (typeof c === "string") {
      return {
        id: `char_${index}`,
        workflowId: `char_${index}`,
        entityType: "character",
        name: c,
        description: c,
        visualTraits: [],
        imageUrls: [],
        sheetImages: [],
        detailImages: [],
        referenceTags: [],
        sheetTags: [],
        detailTags: [],
      };
    }
    const charName = c.name ?? `Character ${index + 1}`;
    const traits = Array.isArray(c.visualTraits)
      ? c.visualTraits
      : (Array.isArray(c.traits) ? c.traits : (c.traits && typeof c.traits === "object" ? Object.entries(c.traits).map(([k, v]) => `${v} ${k}`) : []));
    return {
      id: c.id ?? `char_${index}`,
      workflowId: c.workflowId || c.workflow_id || c.id || `char_${index}`,
      entityType: "character",
      name: charName,
      description: c.description || null,
      visualTraits: traits,
      imageUrls: Array.isArray(c.imageUrls) ? c.imageUrls : [],
      sheetImages: Array.isArray(c.sheetImages) ? c.sheetImages : [],
      detailImages: Array.isArray(c.detailImages) ? c.detailImages : [],
      referenceTags: [],
      sheetTags: [],
      detailTags: [],
    };
  });

  const inputReferences = (Array.isArray(safe.references) ? safe.references : []).map((r, index) => {
    if (typeof r === "string") {
      return {
        id: r,
        workflowId: r.startsWith("http") ? null : r,
        url: r.startsWith("http") ? r : null,
        role: "style_reference",
      };
    }
    return {
      id: r.id || r.workflow_id || r.workflowId || `ref_${index + 1}`,
      workflowId: r.workflow_id || r.workflowId || (r.url ? null : r.id),
      url: r.url || (typeof r.id === "string" && r.id.startsWith("http") ? r.id : null),
      role: r.role || "style_reference",
      ...r,
    };
  });

  // ── Step 2: Resolve references[] from DB / URLs ───────────────────────────
  const refIds = inputReferences
    .map(r => r.url || r.workflowId || r.id)
    .filter(id => typeof id === "string" && id.trim())
    .map(id => id.trim());

  let resolvedList = [];
  try {
    resolvedList = await resolveWorkflowReferences([...new Set(refIds)]);
  } catch (err) {
    console.warn(`[PromptBuilder] resolveWorkflowReferences error:`, err.message);
  }

  // ── Step 3: Build entity map + deduplicated list ──────────────────────────
  const entityMap = new Map();
  const seenKeys = new Set();
  const uniqueEntities = [];

  for (const char of inputCharacters) {
    const key = char.id || char.workflowId;
    if (key && !seenKeys.has(key)) {
      seenKeys.add(key);
      entityMap.set(key, char);
      if (char.name) entityMap.set(char.name, char);
      uniqueEntities.push(char);
    }
  }

  for (const ref of resolvedList) {
    const key = ref.entityId || ref.workflowId;
    if (key && !seenKeys.has(key)) {
      seenKeys.add(key);
      entityMap.set(ref.workflowId, ref);
      if (ref.entityId) entityMap.set(ref.entityId, ref);
      uniqueEntities.push(ref);
    }
  }

  const characters = uniqueEntities.filter(e => e.entityType === "character");
  const elements = uniqueEntities.filter(e => e.entityType === "element");
  const medias = uniqueEntities.filter(e => e.entityType === "media");

  // ── Step 4: Assign @imageN to all entities in natural reference order ─────
  const registry = makeImageRegistry();
  const idToIndexMap = new Map();

  tagEntityImages(uniqueEntities, registry, idToIndexMap);

  // ── Step 5: Format prompt — replace inline tags with @Name / @imageN ─────
  let formattedPrompt = formatPrompt(rawPrompt, entityMap, idToIndexMap);

  // ── Step 6: Handle skill layouts (e.g. character-sheet, storyboard) ───────
  let layoutName = null;
  const promptParts = [];

  if (safe.skill && safe.skill.id) {
    const skillId = safe.skill.id;
    if (skillId === "character-sheet") {
      layoutName = "character-sheet";
      const charNames = characters.map(c => c.name).filter(Boolean);
      const views = safe.skill.parameters?.views || ["front view", "side view", "back view"];
      const viewText = Array.isArray(views) ? views.join(", ") : String(views);
      const parts = [];
      if (formattedPrompt) parts.push(formattedPrompt);
      if (charNames.length > 0 && !formattedPrompt.includes(charNames[0])) {
        parts.push(charNames.join(", "));
      }
      parts.push(`character sheet, multiple views, ${viewText}, concept art, clean composition`);
      formattedPrompt = parts.join(", ");
    } else if (skillId === "storyboard") {
      layoutName = "storyboard";
      const panelCount = safe.skill.parameters?.panel_count ?? 6;
      formattedPrompt = `${formattedPrompt}, storyboard layout, ${panelCount} panel narrative sequence`;
    }
  }

  // If an entity was declared in references but not placed in prompt text, prepend @Tag
  const unmentionedTags = [];
  for (const entity of [...characters, ...elements]) {
    const tag = `@${entity.name}`;
    const escapedTag = tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const tagRegex = new RegExp(`(?<![\\w@])${escapedTag}(?![\\w-])`, "i");
    if (!tagRegex.test(formattedPrompt)) {
      unmentionedTags.push(tag);
    }
  }

  if (unmentionedTags.length > 0 && !safe.skill) {
    promptParts.push(unmentionedTags.join(", "));
  }

  if (formattedPrompt) {
    promptParts.push(formattedPrompt);
  }

  if (safe.style && !promptParts.join(" ").toLowerCase().includes(safe.style.toLowerCase())) {
    promptParts.push(safe.style);
  }

  // ── Step 7: Build [Reference Guide] block ────────────────────────────────
  const guideLines = uniqueEntities
    .map(buildGuideLine)
    .filter(Boolean);

  const guideBlock = guideLines.length > 0
    ? `\n\n[Reference Guide]\n${guideLines.join("\n\n")}`
    : "";

  const finalPromptText = (promptParts.join(", ").trim() + guideBlock).trim();
  const output = finalPromptText || "High quality creative image";

  // ── Step 8: Assemble context ─────────────────────────────────────────────
  const finalContext = {
    userPrompt: formattedPrompt,
    prompt: finalPromptText,
    layout: layoutName,
    imageUrls: registry.all,
    referenceGuide: guideLines,
    standaloneMedia: medias.map(m => ({ label: m.name, tag: m.referenceTags[0] || null })),
    characters: inputCharacters.length > 0 ? inputCharacters : characters,
    references: inputReferences.length > 0 ? inputReferences : (Array.isArray(safe.references) ? safe.references : []),
    entities: {
      characters: characters.map(c => ({
        id: c.entityId || c.id,
        workflowId: c.workflowId || c.id,
        name: c.name,
        description: c.description,
        visualTraits: c.visualTraits,
        imageUrls: c.imageUrls,
        sheetImages: c.sheetImages || [],
        detailImages: c.detailImages || [],
        referenceTags: c.referenceTags || [],
        sheetTags: c.sheetTags || [],
        detailTags: c.detailTags || [],
      })),
      elements: elements.map(e => ({
        id: e.entityId || e.id,
        workflowId: e.workflowId || e.id,
        name: e.name,
        description: e.description,
        visualTraits: e.visualTraits,
        imageUrls: e.imageUrls,
        referenceTags: e.referenceTags || [],
      })),
    },
    style: safe.style ?? null,
    source_asset: safe.source_asset ?? null,
    metadata: {
      runId,
      nodeId,
      userId,
      resolvedCount: uniqueEntities.length,
      timestamp: new Date().toISOString(),
    },
  };

  // ── Log ───────────────────────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║              [PromptBuilder] FINAL PROMPT                   ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log(output);
  console.log("────────────────────────────────────────────────────────────────");
  console.log(
    `[PromptBuilder] Resolved: ${uniqueEntities.length} entities ` +
    `(${characters.length} characters, ${elements.length} elements, ${medias.length} media) | ` +
    `Images: ${registry.all.length}`
  );
  console.log("────────────────────────────────────────────────────────────────\n");

  return { finalPrompt: output, context: finalContext };
}

export default executePromptBuilder;

