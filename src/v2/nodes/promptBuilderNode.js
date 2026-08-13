/**
 * Prompt Builder Node (V2 Architecture Specification)
 * skill_aware: true | provider-backed: false | LLM calls: FALSE (0 LLM Calls)
 *
 * Internal Pipeline:
 *   1. Safety & Bounds Check → NodeSafetyService.assertPromptBuilderInputs
 *   2. Token & Locator Parser → Extract @Tokens (@Sarah) and inline markers (<character:id>)
 *   3. Characteristic Tag Processor → Convert trait/feature tag objects into natural prose
 *   4. Entity & Reference Resolver → Fetch entity metadata & resolve workflow IDs / URLs to media URLs
 *   5. Relevance Filter → Strip DB metadata (createdAt, ownerId, billingFlags)
 *   6. Context Assembler → Produce Normalized Context Snapshot (`context`)
 *   7. Pure Clean Prompt Assembly → Pass prompt without hardcoded text pollution
 *
 * Output: { finalPrompt: string, context: WorkflowContext }
 */

import { NodeSafetyService } from "./safety/NodeSafetyService.js";
import { MediaRepository } from "../../db/MediaRepository.js";

const mediaRepo = new MediaRepository();

/**
 * Resolves a reference item (string workflow ID, HTTP URL, or object) into a full reference object with media URL.
 */
async function resolveReferenceToMedia(ref, idx = 1) {
  if (!ref) return null;

  // Case 1: If ref is an object with url or workflow_id
  if (typeof ref === "object") {
    let url = ref.url || ref.src || ref.file_url || null;
    const refId = ref.workflow_id || ref.workflowId || ref.assetId || ref.id || ref.media_id;

    if (!url && refId && typeof refId === "string" && !refId.startsWith("http")) {
      try {
        const media = await mediaRepo.findMediaByIdOrWorkflow(refId);
        if (media?.url) url = media.url;
      } catch (err) {
        console.warn(`[promptBuilderNode] Failed to resolve media for refId ${refId}: ${err.message}`);
      }
    }

    if (url && typeof url === "string" && url.trim().startsWith("http")) {
      return {
        assetId: refId || `ref_${idx}`,
        workflowId: ref.workflow_id || ref.workflowId || (refId && !refId.startsWith("http") ? refId : null),
        url: url.trim(),
        role: ref.role || "character_reference",
      };
    }
    return null;
  }

  // Case 2: If ref is a string
  if (typeof ref === "string") {
    const trimmed = ref.trim();
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://") || trimmed.startsWith("data:")) {
      return {
        assetId: `ref_${idx}`,
        workflowId: null,
        url: trimmed,
        role: "character_reference",
      };
    }

    // Look up ID (media.id or workflow_id) in DB
    try {
      const media = await mediaRepo.findMediaByIdOrWorkflow(trimmed);
      if (media?.url && media.url.startsWith("http")) {
        return {
          assetId: trimmed,
          workflowId: media.workflow_id || trimmed,
          url: media.url,
          role: "character_reference",
        };
      }
    } catch (err) {
      console.warn(`[promptBuilderNode] Failed to resolve media for ref string ${trimmed}: ${err.message}`);
    }
  }

  return null;
}

/**
 * Strips raw template tag wrappers like <Trait: X> or <Tag: Y> into clean natural words.
 */
function stripRawTagSyntax(text = "") {
  if (typeof text !== "string") return "";
  return text
    .replace(/<(?:Trait|Tag|Feature|Attribute):\s*([^>]+)>/gi, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Process character characteristic tags (traits, features, archetype, gender, etc.)
 * into clean, natural descriptive words.
 */
function processCharacteristicTags(char) {
  if (!char || typeof char !== "object") return [];

  const traitsList = [];

  // 1. Process traits object or array
  if (char.traits) {
    if (Array.isArray(char.traits)) {
      traitsList.push(...char.traits.map(t => stripRawTagSyntax(String(t))));
    } else if (typeof char.traits === "object") {
      for (const [key, val] of Object.entries(char.traits)) {
        if (!val) continue;
        const cleanVal = stripRawTagSyntax(String(val));
        const cleanKey = String(key).trim().toLowerCase();
        
        if (cleanKey === "hair" || cleanKey === "eyes" || cleanKey === "skin") {
          traitsList.push(`${cleanVal} ${cleanKey}`);
        } else if (cleanKey === "outfit" || cleanKey === "clothing") {
          traitsList.push(`wearing ${cleanVal}`);
        } else {
          traitsList.push(`${cleanVal}`);
        }
      }
    }
  }

  // 2. Process features array
  if (Array.isArray(char.features)) {
    traitsList.push(...char.features.map(f => stripRawTagSyntax(String(f))));
  }

  // 3. Process explicit archetype & gender
  if (char.archetype) traitsList.push(stripRawTagSyntax(String(char.archetype)));
  if (char.gender) traitsList.push(stripRawTagSyntax(String(char.gender)));

  // 4. Fallback to description text if no tags provided
  if (traitsList.length === 0 && char.description) {
    traitsList.push(stripRawTagSyntax(String(char.description)));
  }

  return Array.from(new Set(traitsList.filter(Boolean)));
}

/**
 * Filter out heavy DB fields to keep context lean for downstream nodes.
 */
function normalizeCharacter(char) {
  if (!char || typeof char !== "object") return null;

  const characteristicWords = processCharacteristicTags(char);

  return {
    id: char.id ?? char.characterId ?? "char_unknown",
    name: char.name ?? "Character",
    visualTraits: characteristicWords,
    references: Array.isArray(char.references)
      ? char.references.map((r, idx) => ({
          assetId: typeof r === "string" ? `ref_${idx + 1}` : (r.assetId ?? r.id ?? `ref_${idx + 1}`),
          url: typeof r === "string" ? r : (r.url ?? r.src ?? ""),
          role: typeof r === "string" ? "character_reference" : (r.role ?? "character_reference")
        })).filter(r => Boolean(r.url && r.url.trim()))
      : []
  };
}

/**
 * Filter out heavy DB fields for element objects.
 */
function normalizeElement(elem) {
  if (!elem || typeof elem !== "object") return null;
  return {
    id: elem.id ?? elem.elementId ?? "elem_unknown",
    name: elem.name ?? "Element",
    visualTraits: Array.isArray(elem.visualTraits)
      ? elem.visualTraits
      : (elem.description ? [elem.description] : []),
    references: Array.isArray(elem.references)
      ? elem.references.map((r, idx) => ({
          assetId: typeof r === "string" ? `ref_${idx + 1}` : (r.assetId ?? r.id ?? `ref_${idx + 1}`),
          url: typeof r === "string" ? r : (r.url ?? r.src ?? ""),
          role: typeof r === "string" ? "product_reference" : (r.role ?? "product_reference")
        })).filter(r => Boolean(r.url && r.url.trim()))
      : []
  };
}

/**
 * Extract @Tokens (@Sarah) and inline tags (<character:id>, <element:id>) from prompt string.
 */
function parseTokensAndPointers(promptText = "") {
  const tokens = [];

  const atMatches = promptText.match(/@(\w+)/g) || [];
  for (const match of atMatches) {
    tokens.push({ type: "token", value: match.slice(1) });
  }

  const tagMatches = promptText.match(/<(\w+):([^>]+)>/g) || [];
  for (const match of tagMatches) {
    const parts = match.slice(1, -1).split(":");
    tokens.push({ type: parts[0], value: parts[1] });
  }

  return tokens;
}

/**
 * Main Execution Function for Prompt Builder Node.
 * Resolves reference workflow IDs and image URLs directly via MediaRepository.
 *
 * @param {object} resolvedInputs
 * @param {object} ctx - { runId, nodeId, userId, traceId, gateways, deps }
 * @returns {Promise<{ finalPrompt: string, context: object }>}
 */
export async function executePromptBuilder(resolvedInputs, ctx = {}) {
  const { nodeId = "prompt-builder", runId = "run-1", userId = "usr-1" } = ctx;

  // ── 1. Safety & Boundary Check ─────────────────────────────────────────────
  const safe = NodeSafetyService.assertPromptBuilderInputs(resolvedInputs, nodeId);

  // Clean raw <Trait: X> tags from safe.prompt
  const cleanedPrompt = stripRawTagSyntax(safe.prompt);

  // ── 2. Token & Locator Parsing ──────────────────────────────────────────────
  const parsedTokens = parseTokensAndPointers(cleanedPrompt);

  // ── 3. Entity & Reference Resolution ────────────────────────────────────────
  const rawCharacters = safe.characters ?? [];
  const rawElements = safe.elements ?? [];
  const rawReferences = safe.references ?? [];

  const normalizedCharacters = rawCharacters
    .map(normalizeCharacter)
    .filter(Boolean);

  const normalizedElements = rawElements
    .map(normalizeElement)
    .filter(Boolean);

  // Resolve workflow IDs / URLs to full media objects with URLs asynchronously
  const resolvedRefPromises = rawReferences.map((ref, idx) => resolveReferenceToMedia(ref, idx + 1));
  const normalizedReferences = (await Promise.all(resolvedRefPromises)).filter(Boolean);

  for (const char of normalizedCharacters) {
    for (const ref of char.references) {
      if (ref.url && !normalizedReferences.some(r => r.url === ref.url)) {
        normalizedReferences.push(ref);
      }
    }
  }

  // ── 4. Context Assembler ────────────────────────────────────────────────────
  const finalContext = {
    userPrompt: cleanedPrompt,
    entities: {
      characters: normalizedCharacters,
      elements: normalizedElements,
    },
    references: normalizedReferences,
    style: safe.style ?? null,
    source_asset: safe.source_asset ?? null,
    tokensParsed: parsedTokens,
    metadata: {
      runId,
      nodeId,
      userId,
      timestamp: new Date().toISOString(),
    },
  };

  // ── 5. Pure Clean Prompt Assembly ──────────────────────────────────────────
  const promptParts = [];

  if (cleanedPrompt) {
    promptParts.push(cleanedPrompt);
  }

  for (const char of normalizedCharacters) {
    if (char.visualTraits.length > 0) {
      const traitText = char.visualTraits.join(", ");
      if (!cleanedPrompt.includes(traitText)) {
        promptParts.push(`${char.name} (${traitText})`);
      }
    }
  }

  if (safe.style && !promptParts.some(p => p.toLowerCase().includes(safe.style.toLowerCase()))) {
    promptParts.push(safe.style);
  }

  const finalPromptText = promptParts.join(", ").trim();

  return {
    finalPrompt: finalPromptText || "High quality creative image",
    context: finalContext,
  };
}

export default executePromptBuilder;
