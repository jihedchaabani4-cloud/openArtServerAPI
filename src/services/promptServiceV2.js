// ============================================================
// promptServiceV2.js
// Full prompt processing pipeline — single file
//
// WHAT THIS FILE DOES:
//   1. Replace <MediaAsset:id> tags with model-specific reference tags
//   2. Build and inject a DNA header block before the prompt
//   3. Build a dynamic edit context block (base image + references)
//   4. One LLM call: safety check + translation + optimization
//
// FUNCTIONS EXPORTED:
//   processPrompt({ prompt, references, modelType, textProvider, isEdit })
//     → Main entry point. Call this from your route/controller.
//
// FUNCTIONS INTERNAL (not exported — used by processPrompt):
//   buildDnaHeader(references)
//     → Builds the DNA context block injected before the prompt
//   buildEditContext(references)
//     → Builds the edit instruction block (base + references roles)
//   replaceMediaAssets(prompt, references, modelType)
//     → Replaces <MediaAsset:id> with the correct tag for the model
//
// CONSTANTS EXPORTED:
//   DNA_LABELS          → human-readable type names used in tags and DNA header
//   MODEL_FORMATTERS    → tag format per model (add new models here)
//
// HOW TO ADD A NEW MODEL:
//   Add one entry in MODEL_FORMATTERS below — nothing else changes.
//
// INPUT shape for references[]:
//   {
//     id:      string,       // must match <MediaAsset:id> in prompt
//     label?:  string,       // display name (e.g. "Jamal") — optional
//     type?:   "character"|"place"|"product"|"reference",
//     is_base?: boolean,     // true = base image to edit
//     role?:   "source"|"reference",
//     dna?: {
//       appearance?: string,
//       clothing?:   string,
//       style?:      string,
//       extra?:      string,
//       description?: string,
//       atmosphere?:  string,
//       details?:     string,
//     }
//   }
//
// OUTPUT shape of processPrompt():
//   {
//     success: boolean,
//     safety:  boolean,
//     reason:  string | null,
//     prompt:  string
//   }
// ============================================================


// ============================================================
// SECTION 1 — DNA_LABELS
// ============================================================

export const DNA_LABELS = {
  character: "character reference",
  place:     "location reference",
  product:   "product reference",
  reference: "visual reference",
}


// ============================================================
// SECTION 2 — MODEL_FORMATTERS
// ============================================================

export const MODEL_FORMATTERS = {

  kling: {
    tag: (type, pos) => {
      const label = DNA_LABELS[type] ?? "visual reference"
      return `@image${pos}(${label})`
    },
  },

  runway: {
    tag: (type, pos) => {
      const prefix = { character: "Character", place: "Place", product: "Product" }
      const label  = DNA_LABELS[type] ?? "visual reference"
      return `@${prefix[type] ?? "Image"}${pos}(${label})`
    },
  },

  pika: {
    tag: (type, pos) => {
      const label = DNA_LABELS[type] ?? "visual reference"
      return `[ref${pos}(${label})]`
    },
  },

  veo: {
    tag: (type, pos) => {
      const label = DNA_LABELS[type] ?? "visual reference"
      return `[subject ${pos}(${label})]`
    },
  },

  hailuo: {
    tag: (type, pos) => {
      const label = DNA_LABELS[type] ?? "visual reference"
      return `[image ${pos}(${label})]`
    },
  },

  // image edit models
  "gpt-image-2": {
    tag: (type, pos) => {
      const label = DNA_LABELS[type] ?? "visual reference"
      return `@image${pos}(${label})`
    },
  },

  "nano-banana-pro": {
    tag: (type, pos) => {
      const label = DNA_LABELS[type] ?? "visual reference"
      return `@image${pos}(${label})`
    },
  },

  "seedream-pro": {
    tag: (type, pos) => {
      const label = DNA_LABELS[type] ?? "visual reference"
      return `@image${pos}(${label})`
    },
  },

}


// ============================================================
// SECTION 3 — resolveRefType (internal)
// ============================================================

function resolveRefType(ref) {
  if (["character", "place", "product", "reference"].includes(ref.type)) return ref.type
  if (ref.role === "character")                      return "character"
  if (ref.role === "place" || ref.role === "location") return "place"
  if (ref.role === "product")                        return "product"
  return "reference"
}


// ============================================================
// SECTION 4 — buildDnaHeader (internal)
// Builds the DNA context block — only for refs that have DNA.
//
// Output example:
//   [CHARACTER DNA]
//   reference 1 (character reference): Jamal
//     appearance: young Arab man, short black hair
//     clothing: white t-shirt, jeans
//     style: realistic
// ============================================================

function buildDnaHeader(references) {
  if (!references?.length) return ""

  const lines = []
  let hasDna  = false

  references.forEach((ref, i) => {
    if (!ref.dna || !Object.keys(ref.dna).length) return

    if (!hasDna) {
      lines.push("[CHARACTER DNA]")
      hasDna = true
    }

    const pos       = i + 1
    const actualType = resolveRefType(ref)
    const typeLabel  = DNA_LABELS[actualType] ?? "visual reference"

    lines.push(`reference ${pos} (${typeLabel}): ${ref.label ?? "unnamed"}`)

    const d = ref.dna

    if (actualType === "character") {
      if (d.description) lines.push(`  description: ${d.description}`)
      if (d.appearance)  lines.push(`  appearance: ${d.appearance}`)
      if (d.clothing)    lines.push(`  clothing: ${d.clothing}`)
    }

    if (actualType === "place") {
      if (d.description) lines.push(`  description: ${d.description}`)
      if (d.atmosphere)  lines.push(`  atmosphere: ${d.atmosphere}`)
    }

    if (actualType === "product") {
      if (d.description) lines.push(`  description: ${d.description}`)
      if (d.details)     lines.push(`  details: ${d.details}`)
    }

    if (actualType === "reference") {
      if (d.description) lines.push(`  description: ${d.description}`)
    }
  })

  return lines.join("\n")
}


// ============================================================
// SECTION 5 — buildEditContext (internal) 🔥 NEW
// Builds edit instruction block when is_base is present.
// Tells the LLM clearly: which image is base, which are refs.
//
// Output example (with DNA):
//   [EDIT CONTEXT]
//   image 1 → BASE IMAGE (modify this)
//     character: Jamal
//     appearance: young Arab man...
//   image 2 → REFERENCE (do not copy composition)
//     character: Sara
//
// Output example (without DNA):
//   [EDIT CONTEXT]
//   image 1 → BASE IMAGE (modify this)
//   image 2 → REFERENCE
// ============================================================

function buildEditContext(references) {
  if (!references?.length) return ""

  // Check if any reference is a base image
  const hasBase = references.some(r => r.is_base || r.role === "source")
  if (!hasBase) return ""

  const lines = ["[EDIT CONTEXT]"]

  references.forEach((ref, i) => {
    const pos    = i + 1
    const isBase = ref.is_base || ref.role === "source"

    if (isBase) {
      lines.push(`image ${pos} → BASE IMAGE (this is the image to modify)`)
    } else {
      lines.push(`image ${pos} → REFERENCE (use for inspiration only, do not copy composition)`)
    }

    // Add character name if available (even without full DNA)
    if (ref.label) {
      lines.push(`  character: ${ref.label}`)
    }

    // Add key DNA fields inline if available
    if (ref.dna) {
      const d = ref.dna
      if (d.description) lines.push(`  description: ${d.description}`)
      if (d.appearance)  lines.push(`  appearance: ${d.appearance}`)
      if (d.clothing)    lines.push(`  clothing: ${d.clothing}`)
    }
  })

  return lines.join("\n")
}


// ============================================================
// SECTION 6 — replaceMediaAssets (internal)
// ============================================================

function replaceMediaAssets(prompt, references, modelType) {
  const posMap = {}
  references.forEach((ref, i) => {
    const refId = ref.id || ref.workflow_id || ref.media_id
    if (refId) posMap[refId] = i + 1
  })

  const formatter = MODEL_FORMATTERS[modelType] ?? MODEL_FORMATTERS.kling

  return prompt.replace(/<MediaAsset:([^>]+)>/g, (_, id) => {
    const pos = posMap[id]
    if (!pos) return `[ref:${id.slice(0, 8)}]`
    const ref        = references[pos - 1]
    const actualType = resolveRefType(ref)
    return formatter.tag(actualType, pos)
  })
}


// ============================================================
// SECTION 7 — SYSTEM PROMPTS (internal)
// Two modes:
//   - SYSTEM_PROMPT_GENERATE → classic generate (no base image)
//   - SYSTEM_PROMPT_EDIT     → edit mode (base image + references)
// ============================================================

const SYSTEM_PROMPT_GENERATE = `
You are a prompt processor for AI video/image generation.

You receive a prompt that may contain:
- A DNA header block (lines starting with "[CHARACTER DNA]") describing each visual reference
- Reference tags like @image1(character reference), @Place2(location reference), [ref3(product reference)]
- User text in any language (Arabic, Tunisian Darija, French, mixed, or English)
- Dialogue inside quotes (e.g. "أنا جمال")

YOUR TWO TASKS:

1. SAFETY CHECK:
   - Flag ONLY explicitly sexual/pornographic content or extreme real-world gore
   - Be lenient with everything else (fiction violence, political figures, satire, etc.)
   - If unsafe: safety=false, explain briefly in reason

2. OPTIMIZATION (only if safe):
   - Translate ALL non-English text to fluent English
   - EXCEPTION: dialogue inside quotes → keep EXACTLY as written, do NOT translate
   - Fix typos, incomplete words, broken expressions
   - Add cinematic/visual details (lighting, atmosphere, camera angle) — keep under 150 words total
   - Preserve the user's core idea — do NOT replace it
   - PRESERVE all reference tags EXACTLY as written (do not modify, reorder, or remove)
   - PRESERVE the DNA header block EXACTLY (all "reference N" lines, unchanged)

OUTPUT: Return ONLY valid JSON, no markdown, no backticks:
{
  "safety": true | false,
  "reason": string | null,
  "prompt": string
}
`.trim()


const SYSTEM_PROMPT_EDIT = `
You are a prompt processor for AI image editing.

You receive a prompt that may contain:
- An [EDIT CONTEXT] block describing which image is the BASE (to modify) and which are REFERENCES
- A [CHARACTER DNA] block with appearance details for each character
- Reference tags like @image1(character reference), @image2(visual reference)
- User text in any language (Arabic, Tunisian Darija, French, mixed, or English)

YOUR TWO TASKS:

1. SAFETY CHECK:
   - Flag ONLY explicitly sexual/pornographic content or extreme real-world gore
   - Be lenient with everything else
   - If unsafe: safety=false, explain briefly in reason

2. OPTIMIZATION (only if safe):
   - Translate ALL non-English text to fluent English
   - Fix typos, incomplete words, broken expressions
   - EDIT RULES (critical):
     * The BASE IMAGE must be modified according to the user request
     * REFERENCE images are used only for inspiration, style, or character consistency
     * Preserve identity, face, pose, and composition of the base image UNLESS the user explicitly asks to change them
     * Do NOT recreate the scene from scratch — apply only the requested modifications
     * If the user adds a character from a reference, integrate them naturally into the base scene
   - Add relevant visual details (lighting, atmosphere) only if they improve the edit
   - Keep under 150 words total
   - PRESERVE all reference tags EXACTLY as written
   - PRESERVE [EDIT CONTEXT] and [CHARACTER DNA] blocks EXACTLY

OUTPUT: Return ONLY valid JSON, no markdown, no backticks:
{
  "safety": true | false,
  "reason": string | null,
  "prompt": string
}
`.trim()


// ============================================================
// SECTION 8 — processPrompt (MAIN EXPORT) 🔥
//
// Dynamic pipeline:
//   - isEdit=true  → uses SYSTEM_PROMPT_EDIT + buildEditContext
//   - isEdit=false → uses SYSTEM_PROMPT_GENERATE (classic)
//   - No references → skips DNA + edit context
//   - No DNA       → skips DNA header but keeps edit context
//
// @param prompt      — raw user string
// @param references  — ordered array of reference objects
// @param modelType   — model name string
// @param textProvider — LLM client
// @param isEdit      — boolean (default: auto-detected from references)
//
// @returns { success, safety, reason, prompt }
// ============================================================

export async function processPrompt({
  prompt,
  references  = [],
  modelType   = "kling",
  textProvider,
  isEdit,     // optional — auto-detected if not provided
}) {
  console.log("🚀 [processPrompt] mode:", isEdit ? "EDIT" : "GENERATE")
  console.log("🚀 [processPrompt] references count:", references.length)
  console.log("🚀 [processPrompt] modelType:", modelType)

  // ── Guard: empty prompt ───────────────────────────────────
  if (!prompt?.trim()) {
    return { success: false, safety: false, reason: "empty prompt", prompt: "" }
  }

  // ── Auto-detect edit mode ─────────────────────────────────
  const editMode = isEdit ?? references.some(r => r.is_base || r.role === "source")

  if (editMode) {
    const bases = references.filter(r => r.is_base || r.role === "source")
    console.log("🛠️ [processPrompt] EDIT MODE DETECTED. Base images:", JSON.stringify(bases, null, 2))
  }

  // ── Step 1: replace <MediaAsset:id> → model tags ─────────
  const replacedPrompt = references.length
    ? replaceMediaAssets(prompt, references, modelType)
    : prompt

  // ── Step 2: build context blocks ─────────────────────────
  const dnaHeader   = buildDnaHeader(references)    // only if DNA exists
  const editContext = editMode
    ? buildEditContext(references)                   // only in edit mode
    : ""

  // ── Step 3: assemble full prompt ──────────────────────────
  const blocks = [
    editContext,   // [EDIT CONTEXT] block — first
    dnaHeader,     // [CHARACTER DNA] block — second
    replacedPrompt // user prompt — last
  ].filter(Boolean)

  const fullPrompt = blocks.join("\n\n")

  // ── Step 4: pick system prompt ────────────────────────────
  const systemPrompt = editMode
    ? SYSTEM_PROMPT_EDIT
    : SYSTEM_PROMPT_GENERATE

  // console.log("📝 [processPrompt] FULL PROMPT SENT TO LLM:\n", fullPrompt)

  // ── Step 5: LLM call ──────────────────────────────────────
  try {
    let parsed
    try {
      parsed = await textProvider.completeJSON({
        systemPrompt,
        userPrompt:  fullPrompt,
        temperature: 0,
      })
    } catch (parseErr) {
      console.error("[processPrompt] JSON parse failed:", parseErr)
      return { success: false, safety: false, reason: "invalid JSON from LLM", prompt: "" }
    }

    if (!parsed.safety) {
      console.log("❌ [processPrompt] PROMPT REJECTED:", parsed.reason)
      return {
        success: false,
        safety:  false,
        reason:  parsed.reason ?? "unsafe content",
        prompt:  "",
      }
    }

    const finalPrompt = parsed.prompt || fullPrompt
    console.log("✅ [processPrompt] FINAL PROMPT:\n", finalPrompt)

    return {
      success: true,
      safety:  true,
      reason:  null,
      prompt:  finalPrompt,
    }

  } catch (err) {
    console.error("[processPrompt] LLM error:", err)
    return { success: false, safety: false, reason: "LLM error", prompt: "" }
  }
}