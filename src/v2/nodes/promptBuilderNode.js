/**
 * Prompt Builder Node (V2 Architecture Specification)
 * skill_aware: true | provider-backed: false | LLM calls: FALSE (0 LLM Calls)
 *
 * Internal Pipeline:
 *   1. Safety & Bounds Check → NodeSafetyService.assertPromptBuilderInputs
 *   2. Token & Locator Parser → Extract @Tokens (@Sarah) and inline markers (<character:id>)
 *   3. Characteristic Tag Processor → Convert trait/feature tag objects into natural prose
 *   4. Entity & Reference Resolver → Fetch entity metadata & references
 *   5. Relevance Filter → Strip DB metadata (createdAt, ownerId, billingFlags)
 *   6. Context Assembler → Produce Normalized Context Snapshot (`context`)
 *   7. Pure Clean Prompt Assembly → Pass prompt without hardcoded text pollution
 *
 * Output: { finalPrompt: string, context: WorkflowContext }
 */

import { NodeSafetyService } from "./safety/NodeSafetyService.js";

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
      ? char.references.map(r => ({
          assetId: r.assetId ?? r.id ?? "ref_unk",
          url: r.url ?? "",
          role: r.role ?? "character_reference"
        }))
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
      ? elem.references.map(r => ({
          assetId: r.assetId ?? r.id ?? "ref_unk",
          url: r.url ?? "",
          role: r.role ?? "product_reference"
        }))
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
 * Pure, non-polluting prompt builder that respects input prompt and cleans raw <Trait: > tags.
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

  const normalizedReferences = rawReferences.map((ref, idx) => ({
    assetId: ref.assetId ?? ref.id ?? `ref_${idx + 1}`,
    url: ref.url ?? "",
    role: ref.role ?? "character_reference",
  }));

  for (const char of normalizedCharacters) {
    for (const ref of char.references) {
      if (!normalizedReferences.some(r => r.url === ref.url)) {
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
