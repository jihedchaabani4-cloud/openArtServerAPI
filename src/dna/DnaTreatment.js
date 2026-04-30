// ============================================================
// DnaTreatment.js
// Clean, structured DNA generator for AI image/video systems
// Compatible with promptServiceV2 pipeline
// ============================================================

const SYSTEM_PROMPT_DNA = `
You are a character DNA generator for AI image/video models.

Your job:
Convert input into SHORT, VISUAL, STRUCTURED DNA.

RULES:
- MAX 40–60 words TOTAL
- NO storytelling
- NO backstory
- NO personality analysis
- ONLY visual attributes useful for generation

STRUCTURE:
- appearance → face, body, hair
- clothing → outfit
- style → rendering (cinematic, anime, realistic…)
- extra → small details (expression, accessories)

OUTPUT JSON ONLY:

{
  "name": string,
  "traits": {
    "appearance": string,
    "clothing": string,
    "style": string,
    "extra": string
  },
  "description": "ONE SHORT sentence (max 12 words)"
}
`.trim()


export class DnaTreatment {
  constructor({ db, textProvider }) {
    this.db = db
    this.textProvider = textProvider
  }

  // ==========================================================
  // MAIN ENTRY
  // ==========================================================
  async run({
    workflow_id,
    features = {},
    description = "",
  }) {
    if (!workflow_id) throw new Error("workflow_id required")

    console.log("🧬 [DnaTreatment] Generating DNA...")

    // 1. Generate DNA from LLM
    const rawDNA = await this.generateDNA({ features, description })

    // 2. Clean & normalize DNA
    const cleanDNA = this.cleanDNA(rawDNA)

    console.log("🧬 [DnaTreatment] Clean DNA:", cleanDNA)

    // 3. Save to DB
    await this.saveDNA(workflow_id, cleanDNA)

    return cleanDNA
  }

  // ==========================================================
  // LLM CALL
  // ==========================================================
  async generateDNA({ features, description }) {
    const userPrompt = `
Features: ${JSON.stringify(features)}
Description: ${description}
    `.trim()

    try {
      const result = await this.textProvider.completeJSON({
        systemPrompt: SYSTEM_PROMPT_DNA,
        userPrompt,
        temperature: 0.4,
      })

      return result
    } catch (err) {
      console.error("[DnaTreatment] LLM error:", err)
      throw new Error("DNA generation failed")
    }
  }

  // ==========================================================
  // CLEAN DNA (CRITICAL)
  // ==========================================================
  cleanDNA(dna) {
    if (!dna) return null

    const traits = dna.traits || {}

    const cleanTraits = {
      appearance: this.limit(traits.appearance, 80),
      clothing:   this.limit(traits.clothing, 80),
      style:      this.limit(traits.style, 60),
      extra:      this.limit(traits.extra, 60),
    }

    // Remove empty fields
    Object.keys(cleanTraits).forEach(key => {
      if (!cleanTraits[key]) delete cleanTraits[key]
    })

    return {
      name: dna.name || "Character",
      description: this.limit(dna.description, 120),
      traits: cleanTraits,
      type: "character",
    }
  }

  // ==========================================================
  // SAVE DNA → DB
  // media → generation_config → dna
  // ==========================================================
  async saveDNA(workflowId, dna) {
    console.log("💾 [DnaTreatment] Saving DNA...")

    // 1. Get primary media
    const media = await this.db.workflows.getPrimaryMedia(workflowId)

    if (!media?.generation_config_id) {
      throw new Error("No generation_config_id found for workflow")
    }

    // 2. Insert DNA
    const { error } = await this.db.dna.client()
      .from("dna")
      .insert({
        generation_config_id: media.generation_config_id,
        name: dna.name,
        type: "character",
        description: dna.description,
        traits: dna.traits,
      })

    if (error) {
      console.error("[DnaTreatment] DB insert error:", error)
      throw error
    }

    console.log("✅ [DnaTreatment] DNA saved successfully")
  }

  // ==========================================================
  // UTILS
  // ==========================================================
  limit(text, max) {
    if (!text || typeof text !== "string") return null
    return text.length > max ? text.slice(0, max) : text
  }
}

