/**
 * Prompt Builder Node (V2 Architecture Specification)
 * skill_aware: true | provider-backed: false | LLM calls: FALSE (0 LLM Calls)
 *
 * Internal Pipeline:
 *   1. Safety & Bounds Check → NodeSafetyService.assertPromptBuilderInputs
 *   2. Token & Locator Parser → Extract @Tokens (@Sarah) and inline markers (<character:id>)
 *   3. Entity & Reference Resolver → Fetch entity metadata via injected gateways/inputs
 *   4. Relevance Filter → Strip DB metadata (createdAt, ownerId, billingFlags)
 *   5. Context Normalizer → Map raw entity schemas into uniform context representation
 *   6. Context Assembler → Produce Normalized Context Snapshot (`context`)
 *   7. Fast Prompt Fallback → Assemble `finalPrompt` string for Fast Mode
 *
 * Output: { finalPrompt: string, context: WorkflowContext }
 */

import { NodeSafetyService } from "./safety/NodeSafetyService.js";

/**
 * Filter out heavy DB fields to keep context lean for downstream nodes.
 */
function normalizeCharacter(char) {
  if (!char || typeof char !== "object") return null;
  return {
    id: char.id ?? char.characterId ?? "char_unknown",
    name: char.name ?? "Character",
    visualTraits: Array.isArray(char.visualTraits)
      ? char.visualTraits
      : (char.description ? [char.description] : []),
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

  // Match @Tokens like @Sarah, @RedBottle
  const atMatches = promptText.match(/@(\w+)/g) || [];
  for (const match of atMatches) {
    tokens.push({ type: "token", value: match.slice(1) });
  }

  // Match inline tags like <character:c1>, <element:e1>
  const tagMatches = promptText.match(/<(\w+):([^>]+)>/g) || [];
  for (const match of tagMatches) {
    const parts = match.slice(1, -1).split(":");
    tokens.push({ type: parts[0], value: parts[1] });
  }

  return tokens;
}

/**
 * Main Execution Function for Prompt Builder Node.
 *
 * @param {object} resolvedInputs
 * @param {object} ctx - { runId, nodeId, userId, traceId, gateways, deps }
 * @returns {Promise<{ finalPrompt: string, context: object }>}
 */
export async function executePromptBuilder(resolvedInputs, ctx = {}) {
  const { nodeId = "prompt-builder", runId = "run-1", userId = "usr-1" } = ctx;

  // ── 1. Safety & Boundary Check ─────────────────────────────────────────────
  const safe = NodeSafetyService.assertPromptBuilderInputs(resolvedInputs, nodeId);

  // ── 2. Token & Locator Parsing ──────────────────────────────────────────────
  const parsedTokens = parseTokensAndPointers(safe.prompt);

  // ── 3. Entity & Reference Resolution ────────────────────────────────────────
  // Unpack and normalize characters and elements passed explicitly or parsed
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
    role: ref.role ?? "style_reference",
  }));

  // ── 4. Context Assembler ────────────────────────────────────────────────────
  const finalContext = {
    userPrompt: safe.prompt,
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

  // ── 5. Fast Prompt Fallback Construction ──────────────────────────────────
  // Assemble a clean production-ready prompt string for Fast/Free Mode (0 LLM cost)
  const promptParts = [];

  if (safe.prompt) {
    promptParts.push(safe.prompt);
  }

  // Prepend character trait summaries if available
  for (const char of normalizedCharacters) {
    if (char.visualTraits.length > 0 && !safe.prompt.includes(char.name)) {
      promptParts.push(`${char.name} (${char.visualTraits.join(", ")})`);
    }
  }

  // Add style if present and not already mentioned
  if (safe.style && !promptParts.some(p => p.toLowerCase().includes(safe.style.toLowerCase()))) {
    promptParts.push(safe.style);
  }

  const fastPromptFallback = promptParts.join(", ").trim();

  return {
    finalPrompt: fastPromptFallback || "High quality creative image",
    context: finalContext,
  };
}

export default executePromptBuilder;
