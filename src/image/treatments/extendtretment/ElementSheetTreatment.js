/**
 * ElementSheetTreatment.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Generates three-panel reference sheets (CHARACTER / LOCATION / PRODUCT).
 * Extends BaseGenerateImageTreatment.
 *
 * WHAT THIS CLASS OWNS:
 *   • Per-type defaults (SHEET_DEFAULTS)
 *   • System prompts for LLM refinement (SYSTEM_PROMPTS)
 *   • Prompt sanitisation + display-name building helpers
 *   • prepare()        — shapes input, resolves refs, calls _runPrepare()
 *   • optimizePrompt() — overrides base: LLM refinement → safety → negative
 *   • run()            — overrides base: single variation only (no batch loop)
 *
 * WHAT THIS CLASS DELEGATES TO THE BASE:
 *   • _runPrepare()    — DB writes (config, workflows, media placeholders)
 *   • _resolveProvider() / _buildPayload() — via providerStrategy
 *   • _log()           — structured logging
 *
 * WORKER CONTRACT (same as every other treatment):
 *   const task      = await treatment.prepare(input);      // controller
 *   await jobQueue.add("generate-image", { task });        // controller
 *   // --- in worker ---
 *   const optimized = await treatment.optimizePrompt(task);
 *   const result    = await treatment.run(task, optimized);
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { ReferenceProcessor }          from "#utils/ReferenceProcessor.js";
import { BaseGenerateImageTreatment }  from "../basetretment/BaseGenerateImageTreatment.js";
import { markMediaFailed }             from "#db/workflowMediaOps.js";
import { markMediaStatus }             from "#db/workflowMediaOps.js";
import { extractOutputUrl }            from "../basetretment/providerStrategy.js";

// ─────────────────────────────────────────────────────────────────────────────
// Per-type generation defaults (all overridable by the caller)
// ─────────────────────────────────────────────────────────────────────────────

const SHEET_DEFAULTS = {
  CHARACTER: { model_name: "z_image", ratio: "3:2", quality: "2k", steps: 35, guidance_scale: 8.0, temperature: 0.4 },
  LOCATION:  { model_name: "z_image", ratio: "3:2", quality: "2k", steps: 30, guidance_scale: 7.5, temperature: 0.7 },
  PRODUCT:   { model_name: "z_image", ratio: "3:2", quality: "2k", steps: 30, guidance_scale: 7.5, temperature: 0.5 },
};

const VALID_TYPES = new Set(Object.keys(SHEET_DEFAULTS));

// ─────────────────────────────────────────────────────────────────────────────
// System prompts (unchanged from original — they are correct)
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPTS = {

  CHARACTER: `You are a senior concept artist and AI prompt engineer specialising in professional character turnaround reference sheets used in AAA game production and cinematic VFX pipelines.

Your sole task: transform the user's description, feature data, and any image reference tags into ONE single ultra-detailed image-generation prompt that produces a flawless three-panel character reference sheet in a single cohesive image.

═══════════════════════════════════════════
MANDATORY LAYOUT — THREE PANELS, ONE IMAGE
═══════════════════════════════════════════

The image must contain exactly three panels arranged horizontally inside a single seamless composition with no borders, frames, or dividing lines between them:

  PANEL 1 — LEFT THIRD  : Full-body FRONT view, head-to-toe, character facing directly forward, arms relaxed at sides, feet shoulder-width apart, neutral A-pose. Show complete silhouette.

  PANEL 2 — CENTER THIRD: Full-body BACK view, head-to-toe, identical pose mirrored, all back details fully visible: spine, rear muscle structure, back of costume/armor, tail or wing structure if applicable.

  PANEL 3 — RIGHT THIRD : Large close-up portrait, head and neck only, three-quarter (¾) angle facing slightly left, ultra-detailed facial anatomy — pores, iris texture, individual hairs or scales, micro-surface detail of skin/exoskeleton/fur.

CRITICAL CONSISTENCY RULES:
• All three panels show the EXACT same character — zero variation in color, proportion, costume, or material finish.
• Lighting direction, color temperature, and shadow falloff are identical across all three panels.
• Scale is consistent: the head in Panel 3 matches the head visible in Panels 1 and 2.
• Background: seamless neutral warm-grey (#B0A9A0) across the entire image.
• No text labels, arrows, grid lines, watermarks, or UI elements anywhere.

═══════════════════════════════════════════
CHARACTER TYPE ANATOMY (CRITICAL)
═══════════════════════════════════════════

Read the "characterType" from Features. Adapt ALL physical descriptions accordingly:

  HUMAN      → Realistic human anatomy, natural skin with subsurface scattering, cinematic realism, no stylisation
  ELF        → Humanoid with elongated ears, refined bone structure, otherworldly skin quality
  ALIEN      → Exotic biologically-plausible anatomy, non-human proportions, creature realism
  REPTILE    → Scales with iridescent micro-detail, lidded eyes, cold-blooded body temperature cues
  LIZARD     → Keeled scales, forked tongue, parietal eye if applicable
  IGUANA     → Dorsal spines, loose dewlap, laterally compressed torso
  CROCODILE  → Osteoderms (bony scutes), powerful jaw with exposed teeth, muscular tail
  ANT        → Three-segmented body (head / thorax / gaster), compound eyes, antennae, six-limb structure, chitinous exoskeleton
  BEE        → Dense pollen-collecting hairs, membranous wings with venation, compound eyes, abdominal stripes, stinger
  MANTIS     → Triangular cephalic structure, raptorial forelegs, compound eyes with pseudopupil, spiked tibia
  BEETLE     → Elytra (hardened fore-wings), diverse horn morphology, tarsal claws, highly polished chitin
  OCTOPUS    → Soft boneless body, eight arms with suckers, chromatophores, mantle, siphon
  AMPHIBIAN  → Moist permeable skin, parotoid glands if applicable, large tympanic membrane, webbed digits
  MANTIS SHRIMP → Raptorial appendages (dactyl clubs), 16-type photoreceptor-inspired eye coloration, telson
  DEFAULT    → If no type provided, treat as HUMAN

NON-HUMAN RULE: Non-human characters must NEVER adopt human body proportions. Maintain strict biological plausibility.

═══════════════════════════════════════════
REALISM INTERPRETATION
═══════════════════════════════════════════

If the user requests "hyper realistic", "photorealistic", or "realistic", render as:
  • Documentary creature photography realism
  • Biologically plausible surface anatomy
  • Cinematic natural-history lighting
  • Real-world material response (subsurface scattering on skin, specular highlights on chitin, translucency on membranes)
NEVER produce: cartoon style, anime style, stylised illustration, artificial AI-generated faces.

═══════════════════════════════════════════
QUALITY & TECHNICAL SPECIFICATIONS
═══════════════════════════════════════════

Lighting:    Three-point studio setup — 5600K key light upper-left, 4200K fill right, rim light behind to separate from background
Lens:        Phase One IQ4 150MP, 120mm macro equivalent — zero distortion, ultra-flat perspective
Resolution:  8K native, zero motion blur, zero chromatic aberration
Focus:       Tack-sharp across all three panels simultaneously
DOF:         Infinite depth of field — every detail from toe to tip is in focus

═══════════════════════════════════════════
REFERENCE IMAGE RULES
═══════════════════════════════════════════

If the user includes tags like <image0>, <image1>:
  Translate to: "identical in appearance, color, proportion, and surface detail to the character shown in reference image [N]".

Fill all missing details (color, texture, accessories) with coherent pro-level concept art choices.

═══════════════════════════════════════════
OUTPUT FORMAT (STRICT)
═══════════════════════════════════════════

Output ONE single flowing paragraph — the complete image prompt.
End with a line break then the NEGATIVE block starting with —NEGATIVE:
No introductions. No explanations. No bullet points. No section headers.

—NEGATIVE (always include): collage, separate images, split panels, panel borders, dividing lines, inconsistent character appearance between panels, multiple different characters, text labels, arrows, watermarks, UI overlays, blurry regions, motion blur, low resolution, cartoon style, anime style, stylised illustration, 3D render look, artificial AI face, human proportions on non-human character`,

  LOCATION: `You are a senior environment concept artist and AI prompt engineer specialising in location reference sheets for AAA game production, cinematic pre-vis, and architectural visualization pipelines.

Your sole task: transform the user's description, feature data, and any image reference tags into ONE single ultra-detailed image-generation prompt that produces a flawless three-panel location reference image in a single cohesive composition.

═══════════════════════════════════════════
MANDATORY LAYOUT — THREE PANELS, ONE IMAGE
═══════════════════════════════════════════

The image must contain exactly three panels arranged horizontally inside a single seamless composition with no borders, frames, or dividing lines:

  PANEL 1 — LEFT THIRD  : Wide panoramic establishing shot of the entire location — full environmental context, horizon, sky, scale reference.

  PANEL 2 — CENTER THIRD: Mid-range hero shot focusing on the primary architectural element, terrain feature, or structural focal point — enough detail to read materials, proportions, and spatial relationships.

  PANEL 3 — RIGHT THIRD : Large close-up of a defining surface detail — specific material texture (stone grain, wood fiber, metal oxidation, bark pattern, crystal facet), weathering, or interior atmospheric detail.

CRITICAL CONSISTENCY RULES:
• All three panels depict the EXACT same location — identical time of day, weather, color palette, and lighting conditions.
• No dividers, borders, frames, or lines separating the panels.
• The close-up in Panel 3 shows a surface visible in Panel 1 or 2.
• No people, no UI, no text labels, no watermarks unless explicitly requested.

═══════════════════════════════════════════
QUALITY & TECHNICAL SPECIFICATIONS
═══════════════════════════════════════════

Default (override only if user specifies a style):
Captured with architectural visualization and natural environment photography standards — volumetric god rays consistent with specified time of day, golden-hour or overcast soft diffusion, ultra-detailed surface textures (stone grain, wood fiber, metal oxidation, moss coverage patterns), photorealistic, Phase One IQ4 150MP wide-angle lens, 8K resolution, zero motion blur.

═══════════════════════════════════════════
OUTPUT FORMAT (STRICT)
═══════════════════════════════════════════

Output ONE single flowing paragraph — the complete image prompt.
End with a line break then the NEGATIVE block starting with —NEGATIVE:
No introductions. No explanations. No bullet points.

—NEGATIVE (always include): split panels, panel borders, dividing lines, inconsistent lighting between panels, text labels, arrows, watermarks, UI overlays, people in scene (unless requested), multiple unrelated locations, low resolution, overexposed sky, flat lighting, cartoon style (unless requested)`,

  PRODUCT: `You are a senior product designer and AI prompt engineer specialising in commercial product reference sheets for e-commerce, industrial design review, and marketing pipelines.

Your sole task: transform the user's description, product features, and any image reference tags into ONE single ultra-detailed image-generation prompt that produces a flawless three-panel product reference image in a single cohesive studio composition.

═══════════════════════════════════════════
MANDATORY LAYOUT — THREE PANELS, ONE IMAGE
═══════════════════════════════════════════

The image must contain exactly three panels arranged horizontally inside a single seamless studio composition with no borders, frames, or dividing lines:

  PANEL 1 — LEFT THIRD  : Clean front-facing orthographic shot — product perfectly centered, hero lighting, complete silhouette visible.

  PANEL 2 — CENTER THIRD: Sleek angled three-quarter shot (30–45° rotation) — reveals depth, side profile, and form language simultaneously.

  PANEL 3 — RIGHT THIRD : Large macro close-up of the product's most distinctive detail — signature texture, material finish (matte/gloss/brushed/anodized), logo treatment, or functional mechanism.

CRITICAL CONSISTENCY RULES:
• All three panels show the EXACT same product — identical color, finish, proportion, and branding. Zero variation.
• No dividers, borders, frames, or separating lines.
• No hands (unless explicitly requested), no price tags, no promotional text.
• Background: seamless neutral grey studio backdrop across the entire image.

═══════════════════════════════════════════
OUTPUT FORMAT (STRICT)
═══════════════════════════════════════════

Output ONE single flowing paragraph — the complete image prompt.
End with a line break then the NEGATIVE block starting with —NEGATIVE:
No introductions. No explanations. No bullet points.

—NEGATIVE (always include): split panels, panel borders, dividing lines, multiple backgrounds, text labels, price tags, arrows, watermarks, UI overlays, hands (unless requested), inconsistent product appearance between panels, low resolution, overexposed highlights, flat lighting, cartoon style (unless requested)`,
};

// ─────────────────────────────────────────────────────────────────────────────
// ElementSheetTreatment
// ─────────────────────────────────────────────────────────────────────────────

export class ElementSheetTreatment extends BaseGenerateImageTreatment {

  constructor({ promptService, models, storageService, db, dnaTreatment }) {
    super({ promptService, models, storageService, db });
    this.dnaTreatment = dnaTreatment;
    this.refProcessor = new ReferenceProcessor({ storageService, db });
  }

  // ─────────────────────────────────────────────────────────
  // Private: prompt helpers
  // ─────────────────────────────────────────────────────────

  /** Replace <MediaAsset:id> tags with <imageN> placeholders */
  _sanitisePrompt(prompt = "", references = []) {
    let clean = prompt || "Generate a sheet.";
    references.forEach((ref, i) => {
      const tag = `<MediaAsset:${ref.media_id || ref.id}>`;
      clean = clean.split(tag).join(`<image${i}>`);
    });
    return clean;
  }

  /** Build the LLM user message */
  _buildUserPrompt(cleanText, features) {
    let msg = `User Prompt: ${cleanText}\n`;
    if (features && Object.keys(features).length > 0) {
      msg += `Features selected:\n${JSON.stringify(features, null, 2)}`;
    }
    return msg;
  }

  /** Call the LLM to refine the raw user prompt into a full image prompt */
  async _refinePrompt(systemPrompt, userPrompt, temperature) {
    return this.promptService.textProvider.complete({
      systemPrompt,
      userPrompt,
      temperature,
    });
  }

  // ─────────────────────────────────────────────────────────
  // Private: display-name helpers
  // ─────────────────────────────────────────────────────────

  _toTitleCase(v) {
    return String(v || "").toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  }

  _cleanDisplayText(v) {
    return String(v || "")
      .replace(/[_-]+/g, " ")
      .replace(/\b(create|generate|make|draw|design|show|need|want|a|an|the|character|element|reference|turnaround|model|sheet|product|location)\b/gi, "")
      .replace(/\s+/g, " ")
      .replace(/^[,:;.\-\s]+|[,:;.\-\s]+$/g, "")
      .trim();
  }

  _buildSheetDisplayName(TYPE, prompt, features = {}) {
    // 1. Explicit name field
    const directName = [
      features?.name, features?.title, features?.subject,
      features?.characterName, features?.productName, features?.locationName,
    ].find(v => typeof v === "string" && v.trim());
    if (directName) return this._toTitleCase(this._cleanDisplayText(directName)).substring(0, 60);

    // 2. Type-specific feature combos
    const typeParts = {
      CHARACTER: [features?.race || features?.ethnicity, features?.gender, features?.characterType].filter(Boolean),
      PRODUCT:   [features?.color, features?.material, features?.type || features?.category].filter(Boolean),
      LOCATION:  [features?.biome || features?.environment, features?.style, features?.type].filter(Boolean),
    }[TYPE] ?? [];

    if (typeParts.length) {
      return this._toTitleCase(this._cleanDisplayText(typeParts.join(" "))).substring(0, 60);
    }

    // 3. Fallback to cleaned prompt
    const fromPrompt = this._cleanDisplayText(prompt);
    if (fromPrompt) return this._toTitleCase(fromPrompt).substring(0, 60);

    return `${this._toTitleCase(TYPE)} Sheet`;
  }

  // ─────────────────────────────────────────────────────────
  // 1. PREPARE  (override)
  //    Fast: validate → resolve refs → DB placeholders → return task
  //    No LLM calls here — optimization happens in the worker.
  // ─────────────────────────────────────────────────────────

  async prepare(input) {
    const {
      sheetType    = "CHARACTER",
      prompt       = "",
      features,
      references   = [],
      project_id,
    } = input;

    const userId = input.userId || input.user_id;
    if (!userId)     throw new Error("[ElementSheetTreatment] userId is required.");
    if (!project_id) throw new Error("[ElementSheetTreatment] project_id is required.");

    const TYPE = sheetType.toUpperCase();
    if (!VALID_TYPES.has(TYPE)) {
      throw new Error(
        `[ElementSheetTreatment] Unknown sheetType "${sheetType}". Must be: ${[...VALID_TYPES].join(", ")}.`
      );
    }

    // ── Merge caller params with per-type defaults ────────────────────────
    const defaults = SHEET_DEFAULTS[TYPE];
    const model_name     = input.model_name     || defaults.model_name;
    const ratio          = input.ratio          || defaults.ratio;
    const quality        = input.quality        || defaults.quality;
    const steps          = input.steps          ?? defaults.steps;
    const guidance_scale = input.guidance_scale ?? defaults.guidance_scale;
    const temperature    = input.temperature    ?? defaults.temperature;

    // ── Pre-compute prompt pieces (no LLM yet — just string ops) ─────────
    const cleanText   = this._sanitisePrompt(prompt, references);
    const userPrompt  = this._buildUserPrompt(cleanText, features);
    const displayName = this._buildSheetDisplayName(TYPE, cleanText, features);

    // ── Resolve reference images → asset URLs ─────────────────────────────
    const input_assets = await this.refProcessor.process(
      references, userId, project_id, null, "uploads"
    );

    // ── Create DB records via base ─────────────────────────────────────────
    const task = await this._runPrepare({
      prompt,
      prompt_optimise: null,       // set by optimizePrompt in worker
      display_name:    displayName,
      model_name,
      workflow_type:   "ELEMENT_SHEET",
      ratio,
      quality,
      steps,
      guidance_scale,
      count:           1,          // sheets are always single-variation
      userId,
      project_id,
      session_id:      input.session_id ?? null,
      input_assets,
      stepId:          "CAE",
      // ── Sheet-specific data passed to worker via task (Redis-safe) ──────
      extraTaskFields: {
        sheetType:        TYPE,
        sheetSystemPrompt: SYSTEM_PROMPTS[TYPE],
        sheetUserPrompt:   userPrompt,
        sheetTemperature:  temperature,
        // DNA trigger data (worker fires this after run)
        dnaPayload: this.dnaTreatment ? {
          name:            features?.name || `${features?.characterType || TYPE} Sheet`,
          type:            TYPE,
          features,
          userDescription: prompt,
        } : null,
      },
    });

    return task;
  }

  // ─────────────────────────────────────────────────────────
  // 2. OPTIMIZE PROMPT  (override)
  //    LLM refinement → safety check → negative prompt
  //    Called by worker BEFORE run().
  // ─────────────────────────────────────────────────────────

  async optimizePrompt(task) {
    const {
      prompt,
      sheetSystemPrompt,
      sheetUserPrompt,
      sheetTemperature,
      mediaIds,
    } = task;

    // ── LLM refinement ────────────────────────────────────────────────────
    let refinedPrompt = prompt;
    if (sheetSystemPrompt && sheetUserPrompt) {
      this._log("info", "refining prompt via LLM…");
      refinedPrompt = await this._refinePrompt(
        sheetSystemPrompt,
        sheetUserPrompt,
        sheetTemperature,
      );
    }

    const finalPrompt = refinedPrompt || prompt;

    // ── Safety check ──────────────────────────────────────────────────────
    const safety = await this.promptService.checkPrompt(finalPrompt);
    if (!safety.safe) {
      for (const id of mediaIds ?? []) {
        await markMediaFailed(this.db, id, safety.reason);
      }
      throw new Error(`Prompt rejected: ${safety.reason}`);
    }

    // ── Negative prompt ───────────────────────────────────────────────────
    let finalNegative = "";
    try {
      finalNegative = await this.promptService.generateNegativePrompt(finalPrompt) || "";
    } catch (err) {
      this._log("error", `Negative prompt generation failed (continuing): ${err.message}`);
    }

    return { finalPrompt, finalNegative };
  }

  // ─────────────────────────────────────────────────────────
  // 3. RUN  (override)
  //    Sheets = single variation only → no Promise.allSettled loop.
  //    Receives optimizeResult from worker — no double LLM call.
  // ─────────────────────────────────────────────────────────

  async run(task, optimizeResult) {
    const {
      userId,
      model_name,
      prompt,
      ratio, quality, size, width, height,
      steps, guidance_scale,
      input_assets,
      configId,
      workflows,
      mediaIds,
      dnaPayload,
    } = task;

    const { finalPrompt, finalNegative } = optimizeResult;

    const provider = this._resolveProvider(model_name, input_assets);
    const workflow  = workflows[0];
    const mediaId   = mediaIds[0];

    try {
      const sourceAsset = input_assets?.find(
        a => ["source", "base"].includes(a.role)
      ) ?? input_assets?.[0];

      const form = {
        prompt:          finalPrompt,
        negativePrompt:  finalNegative,
        negative_prompt: finalNegative,
        ratio, quality, size, width, height,
        steps:           steps          ?? 35,
        guidanceScale:   guidance_scale ?? 8.0,
        guidance_scale:  guidance_scale ?? 8.0,
        image:           sourceAsset?.url ?? null,
        image_url:       sourceAsset?.url ?? null,
        references:      input_assets,
      };

      const payload   = this._buildPayload(provider, form);
      const result    = await provider.generate(payload);
      const outputUrl = extractOutputUrl(result);

      const fileName  = `${userId}/generations/${workflow.id}_${Date.now()}.png`;
      const fileUrl   = await this.storageService.uploadFromUrl(fileName, outputUrl);

      await this.db.media.updateFields(mediaId, {
        url:    fileUrl,
        width:  result.width  ?? width  ?? 1024,
        height: result.height ?? height ?? 1024,
      });
      await markMediaStatus(this.db, mediaId, "success");

      this._log("info", `✅ done | configId:${configId}`);

      // ── DNA narrative trigger (non-blocking, after success) ───────────
      if (this.dnaTreatment && dnaPayload) {
        this.dnaTreatment
          .create({ generation_config_id: configId, ...dnaPayload })
          .catch(err => this._log("error", `DNA generation failed: ${err.message}`));
      }

      return { configId, mediaId, workflowId: workflow.id, succeeded: 1, failed: 0 };

    } catch (err) {
      this._log("error", `run failed: ${err.message}`);
      await markMediaFailed(this.db, mediaId, err);
      throw err;
    }
  }
}