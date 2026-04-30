/**
 * ElementSheetTreatment.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Generates three-panel reference sheets (CHARACTER / LOCATION / PRODUCT).
 * NO LLM — prompt built directly from features (deterministic, cinematic).
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { ReferenceProcessor }         from "#utils/ReferenceProcessor.js";
import { BaseGenerateImageTreatment } from "../basetretment/BaseGenerateImageTreatment.js";
import { markMediaFailed }            from "#db/workflowMediaOps.js";
import { markMediaStatus }            from "#db/workflowMediaOps.js";
import { extractOutputUrl }           from "../basetretment/providerStrategy.js";

// ─────────────────────────────────────────────────────────────────────────────
// SHEET DEFAULTS
// ─────────────────────────────────────────────────────────────────────────────

const SHEET_DEFAULTS = {
  CHARACTER: { model_name: "gpt-image-2", ratio: "3:2", quality: "2k", steps: 40, guidance_scale: 9.0 },
  LOCATION:  { model_name: "z_image",  ratio: "3:2", quality: "2k", steps: 30, guidance_scale: 7.5 },
  PRODUCT:   { model_name: "z_image",  ratio: "3:2", quality: "2k", steps: 30, guidance_scale: 7.5 },
};

const VALID_TYPES = new Set(Object.keys(SHEET_DEFAULTS));

// ─────────────────────────────────────────────────────────────────────────────
// FEATURE MAPS  (keys = exact frontend values)
// ─────────────────────────────────────────────────────────────────────────────

// --- CHARACTER TYPE ---
const CHARACTER_TYPE_MAP = {
  human:      { desc: "human", isHumanoid: true  },
  elf:        { desc: "fantasy elf with delicately pointed ears and ethereal features", isHumanoid: true  },
  alien:      { desc: "extraterrestrial alien being", isHumanoid: false },
  ant:        { desc: "anthropomorphic ant character with a powerful segmented exoskeleton, compound eyes, and articulated antennae", isHumanoid: false },
  bee:        { desc: "anthropomorphic bee character with golden-striped chitin armor, membranous wings, and large compound eyes", isHumanoid: false },
  octopus:    { desc: "anthropomorphic octopus character with eight dexterous tentacles and iridescent chromatophore skin", isHumanoid: false },
  crocodile:  { desc: "anthropomorphic crocodile character with heavily armored scute-covered hide and powerful reptilian jaw", isHumanoid: false },
  iguana:     { desc: "anthropomorphic iguana character with layered dorsal spines and textured scale-covered body", isHumanoid: false },
  lizard:     { desc: "anthropomorphic lizard character with smooth scaled skin and a long articulated tail", isHumanoid: false },
  beetle:     { desc: "anthropomorphic beetle character with iridescent shell-like elytra and thick chitinous limbs", isHumanoid: false },
  reptile:    { desc: "anthropomorphic reptile character with dense scale-plated body and cold, calculating eyes", isHumanoid: false },
  amphibian:  { desc: "anthropomorphic amphibian character with moist semi-translucent skin and wide expressive eyes", isHumanoid: false },
  mantis:     { desc: "anthropomorphic praying mantis character with raptorial forelegs, triangular head, and faceted compound eyes", isHumanoid: false },
};

// --- GENDER ---
const GENDER_MAP = {
  male:   "man",
  female: "woman",
};

// --- RACE ---
const RACE_MAP = {
  african:        "African",
  asian:          "East Asian",
  european:       "European",
  indian:         "South Asian",
  middle_eastern: "Middle Eastern",
  mixed:          "mixed-heritage",
};

// --- BUILD ---
const BUILD_MAP = {
  slim:     "a slender, willowy frame",
  lean:     "a lean, wiry physique with understated muscle definition",
  athletic: "a powerfully athletic build — broad shoulders, defined musculature, compact waist",
  muscular: "an imposing, heavily muscled physique with thick limbs and a barrel chest",
  curvy:    "a voluptuous, full-figured silhouette with pronounced curves and a defined waist",
  heavy:    "a large, heavy-set frame — solid, substantial, commanding presence",
};

// --- HEIGHT ---
const HEIGHT_MAP = {
  "very-short": "standing well below average height, barely reaching 155 cm",
  "short":      "of short stature, around 155 to 165 cm",
  "average":    "of average height, around 165 to 175 cm",
  "tall":       "tall, standing between 175 and 185 cm",
  "very-tall":  "exceptionally tall, towering over 185 cm",
};

// --- HAIR COLOR ---
const HAIR_COLOR_MAP = {
  black:        "jet-black",
  brown:        "warm chestnut brown",
  blonde:       "natural golden blonde",
  "ash-blonde": "cool ash blonde",
  grey:         "silver-streaked grey",
  white:        "striking snow white",
  auburn:       "rich deep auburn",
  "ash-mauve":  "muted dusty ash mauve — a rare muted purple-grey tint",
};

// --- HAIR TEXTURE ---
const HAIR_TEXTURE_MAP = {
  straight: "poker-straight",
  wavy:     "softly waved",
  curly:    "loosely curled",
  coily:    "densely coiled",
};

// --- HAIR STYLE ---
const HAIR_STYLE_MAP = {
  short: "cut short and close to the scalp",
  long:  "flowing past the shoulders",
  bald:  null, // handled separately
  afro:  "worn in a full, voluminous natural afro",
  punk:  "sculpted into a sharp punk mohawk",
};

// --- EYE COLOR ---
const EYE_COLOR_MAP = {
  brown:        "warm brown eyes",
  "deep-brown": "deep, almost black-brown eyes with rich depth",
  black:        "dark obsidian eyes with nearly invisible irises",
  blue:         "clear, bright blue eyes",
  green:        "vivid green eyes",
  grey:         "cool, pale grey eyes",
  amber:        "golden amber eyes that catch the light",
  red:          "intense crimson-red eyes — a vivid fantasy trait rendered with photorealistic iris texture",
  purple:       "rare violet-purple eyes, luminous and otherworldly",
  white:        "unsettling pale white eyes with no visible iris, ethereal and haunting",
};

// --- SKIN CONDITION ---
const SKIN_CONDITION_MAP = {
  freckles:      "a natural dusting of freckles across the nose and cheekbones",
  wrinkles:      "deep, lived-in wrinkles etched by decades of expression",
  vitiligo:      "striking vitiligo — irregular islands of depigmentation across the skin",
  albinism:      "albinism — near-translucent pale skin and silver-white hair",
  "dry-skin":    "severely cracked, drought-parched skin with deep fissure textures",
  pigmentation:  "uneven skin pigmentation with visible dark patches and tonal variation",
  scars:         "a network of visible scars — both fine silver lines and raised keloid marks",
  birthmarks:    "prominent port-wine birthmarks, each unique in shape and placement",
};

// --- LIMB MODIFICATIONS ---
const LIMB_MAP = {
  prosthetic:  "a prosthetic",
  robotic:     "a sleek robotic",
  mechanical:  "a heavy industrial mechanical",
  cute:        "a whimsical cartoon-styled",
};

// --- OUTFIT ---
const OUTFIT_MAP = {
  casual:         "casual everyday wear — relaxed jeans and a simple t-shirt",
  formal:         "sharp formal attire — a tailored suit or elegant dress",
  sporty:         "fitted athletic sportswear with performance fabrics",
  workwear:       "rugged practical workwear with utility belt and durable fabrics",
  vintage:        "carefully curated vintage clothing evoking a specific past era",
  punk:           "full punk-style outfit — studded leather jacket, ripped fabric, heavy boots, and chains",
  "high-fashion": "avant-garde high-fashion editorial clothing — architectural cuts and unexpected silhouettes",
};

// --- RENDERING STYLE ---
const RENDERING_STYLE_MAP = {
  "hyper-realistic": {
    prompt:   "rendered in ultra-photorealistic detail — natural skin texture with visible pores, fine surface imperfections, cinematic lighting with deep shadows and warm highlights, 8K resolution, indistinguishable from a real professional photograph",
    negative: ["cartoon", "anime", "3D render", "painting", "illustration", "CGI", "stylized"],
  },
  "anime": {
    prompt:   "rendered in high-quality anime art style — clean expressive linework, cel-shaded vibrant colors, dynamic composition, professional studio-quality animation aesthetic",
    negative: ["photorealistic", "3D render", "photograph", "CGI", "hyperrealism"],
  },
  "3d-cartoon": {
    prompt:   "rendered as a high-quality 3D cartoon — smooth stylized surfaces, Pixar-level character quality, soft subsurface lighting, appealing exaggerated proportions",
    negative: ["photorealistic", "anime", "2D illustration", "flat design", "sketch"],
  },
  "2d-illustration": {
    prompt:   "rendered as a professional 2D digital illustration — clean confident linework, rich intentional color palette, editorial illustration quality",
    negative: ["photorealistic", "3D render", "anime", "photograph"],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT FALLBACKS (by race)
// ─────────────────────────────────────────────────────────────────────────────

const RACE_DEFAULTS = {
  african:        { hairColor: "black",  hairTexture: "coily",    eyeColor: "deep-brown" },
  asian:          { hairColor: "black",  hairTexture: "straight", eyeColor: "brown"      },
  european:       { hairColor: "brown",  hairTexture: "wavy",     eyeColor: "blue"       },
  indian:         { hairColor: "black",  hairTexture: "straight", eyeColor: "brown"      },
  middle_eastern: { hairColor: "black",  hairTexture: "wavy",     eyeColor: "brown"      },
  mixed:          { hairColor: "brown",  hairTexture: "wavy",     eyeColor: "brown"      },
};

function getRaceDefault(race, field) {
  return RACE_DEFAULTS[race]?.[field] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// CINEMATIC PROMPT BUILDER  (NO LLM — deterministic)
// ─────────────────────────────────────────────────────────────────────────────

function buildCharacterPrompt(features = {}, userText = "") {
  const identity = features.identity || {};
  const head     = features.head     || {};
  const details  = features.details  || {};

  // ── Rendering Style ─────────────────────────────────────────────────────────
  const renderingKey   = features.renderingStyle || "hyper-realistic";
  const renderingData  = RENDERING_STYLE_MAP[renderingKey] || RENDERING_STYLE_MAP["hyper-realistic"];

  // ── Character Type ───────────────────────────────────────────────────────────
  const charTypeKey  = identity.characterType || "human";
  const charTypeData = CHARACTER_TYPE_MAP[charTypeKey] || CHARACTER_TYPE_MAP["human"];
  const isHumanoid   = charTypeData.isHumanoid;

  // ── Core Identity ────────────────────────────────────────────────────────────
  const age      = identity.age    || "25";
  const gender   = GENDER_MAP[identity.gender] || identity.gender || "person";
  const race     = identity.race;
  const raceDesc = race ? (RACE_MAP[race] || race) : null;

  // ── Build & Height ───────────────────────────────────────────────────────────
  const buildDesc  = identity.build  ? (BUILD_MAP[identity.build]   || identity.build)  : "an average proportional build";
  const heightDesc = identity.height ? (HEIGHT_MAP[identity.height] || identity.height) : null;

  // ── Era ──────────────────────────────────────────────────────────────────────
  const era = features.era || null;

  // ── Outfit ───────────────────────────────────────────────────────────────────
  const outfitDesc = features.outfit
    ? (OUTFIT_MAP[features.outfit] || features.outfit)
    : "casual modern clothing";
  const clothingLine = era
    ? `${outfitDesc}, tailored to the authentic fashion of the ${era}`
    : outfitDesc;

  // ─────────────────────────────────────────────────────────────────────────────
  // HUMANOID PATH (human / elf)
  // ─────────────────────────────────────────────────────────────────────────────
  let paragraphParts = [];

  if (isHumanoid) {

    // Sentence 1 — Opening identity line
    const identityTokens = [`A ${age}-year-old`];
    if (raceDesc) identityTokens.push(raceDesc);
    identityTokens.push(gender);
    if (charTypeKey !== "human") identityTokens.push(`— ${charTypeData.desc}`);
    paragraphParts.push(`${identityTokens.join(" ")}.`);

    // Sentence 2 — Physique
    const physique = heightDesc
      ? `${buildDesc}, ${heightDesc}`
      : buildDesc;
    paragraphParts.push(`They carry ${physique}.`);

    // Sentence 3 — Hair
    const hairStyle = head.hairStyle;
    if (hairStyle === "bald") {
      paragraphParts.push(`Their head is completely shaved — smooth, clean, not a strand of hair.`);
    } else {
      const colorRaw    = head.hairColor   || getRaceDefault(race, "hairColor")   || "brown";
      const textureRaw  = head.hairTexture || getRaceDefault(race, "hairTexture") || "wavy";
      const colorDesc   = HAIR_COLOR_MAP[colorRaw]   || colorRaw;
      const textureDesc = HAIR_TEXTURE_MAP[textureRaw] || textureRaw;

      if (hairStyle === "afro") {
        paragraphParts.push(`Their ${colorDesc} hair is worn in a full, voluminous natural afro — a crown of dense, proud coils.`);
      } else if (hairStyle === "punk") {
        paragraphParts.push(`Their ${colorDesc} hair is sculpted into a sharp, defiant punk mohawk.`);
      } else {
        const styleDesc = hairStyle ? (HAIR_STYLE_MAP[hairStyle] || hairStyle) : "worn at medium length";
        paragraphParts.push(`Their hair is ${colorDesc} and ${textureDesc}, ${styleDesc}.`);
      }
    }

    // Sentence 4 — Eyes
    const eyeRaw  = details.eyeColor || getRaceDefault(race, "eyeColor") || "brown";
    const eyeDesc = EYE_COLOR_MAP[eyeRaw] || eyeRaw;
    paragraphParts.push(`Their eyes are ${eyeDesc}.`);

    // Sentence 5 — Skin condition (optional)
    if (details.skinCondition) {
      const skinDesc = SKIN_CONDITION_MAP[details.skinCondition] || details.skinCondition;
      paragraphParts.push(`Their skin bears ${skinDesc}.`);
    }

    // Sentence 6 — Limb modifications (optional)
    const limbParts = [];
    const limbDefs = [
      { key: "rightArm", label: "right arm" },
      { key: "leftArm",  label: "left arm"  },
      { key: "rightLeg", label: "right leg" },
      { key: "leftLeg",  label: "left leg"  },
    ];
    for (const { key, label } of limbDefs) {
      const val = details[key];
      if (val && val !== "none" && val !== "normal") {
        const mod = LIMB_MAP[val];
        if (mod) limbParts.push(`${mod} ${label}`);
      }
    }
    if (limbParts.length > 0) {
      paragraphParts.push(`In place of natural limbs, they have ${limbParts.join(" and ")}.`);
    }

    // Sentence 7 — Outfit
    paragraphParts.push(`They are dressed in ${clothingLine}.`);

  // ─────────────────────────────────────────────────────────────────────────────
  // NON-HUMAN PATH (alien, ant, bee, octopus, etc.)
  // ─────────────────────────────────────────────────────────────────────────────
  } else {

    // Sentence 1 — Opening line
    paragraphParts.push(`A ${age}-year-old ${charTypeData.desc}.`);

    // Sentence 2 — Physique adapted for creature
    const physique = heightDesc
      ? `${buildDesc}, ${heightDesc}`
      : buildDesc;
    paragraphParts.push(`The creature possesses ${physique}.`);

    // Sentence 3 — Outfit on non-human (optional — only if user chose one)
    if (features.outfit) {
      paragraphParts.push(`It is dressed in ${clothingLine}, adapted to fit its unique anatomy.`);
    }

    // Sentence 4 — Limb modifications (optional)
    const limbParts = [];
    const limbDefs = [
      { key: "rightArm", label: "right appendage" },
      { key: "leftArm",  label: "left appendage"  },
      { key: "rightLeg", label: "right lower limb" },
      { key: "leftLeg",  label: "left lower limb"  },
    ];
    for (const { key, label } of limbDefs) {
      const val = details[key];
      if (val && val !== "none" && val !== "normal") {
        const mod = LIMB_MAP[val];
        if (mod) limbParts.push(`a ${mod} ${label}`);
      }
    }
    if (limbParts.length > 0) {
      paragraphParts.push(`Its body has been modified with ${limbParts.join(" and ")}.`);
    }
  }

  // ── Extra user text ──────────────────────────────────────────────────────────
  const extra = userText?.trim();
  if (extra) {
    paragraphParts.push(`Additional details: ${extra}.`);
  }

  // ── Rendering ────────────────────────────────────────────────────────────────
  paragraphParts.push(`The entire image is ${renderingData.prompt}.`);

  // ── Three-panel layout ───────────────────────────────────────────────────────
  paragraphParts.push(
    "This is a seamless three-panel character reference sheet on a warm neutral grey background (#B0A9A0) with absolutely no borders, frames, or dividing lines between panels. " +
    "The left panel presents the character in a full-body front view — neutral A-pose, arms relaxed at the sides, feet shoulder-width apart, captured head to toe. " +
    "The center panel shows the same character from directly behind in an identical pose, revealing every back detail of their clothing and body. " +
    "The right panel is a large, intimate close-up portrait — the character's head and upper neck rendered at a three-quarter angle, facing slightly to the left. " +
    "The exact same character — the same face, eyes, hair, skin, clothing, and body — must appear with absolute consistency across all three panels. " +
    "Lighting direction, color temperature, and shadow quality are identical in every panel. Zero variation between views."
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // ASSEMBLE FINAL PROMPT
  // ─────────────────────────────────────────────────────────────────────────────

  const finalPrompt = paragraphParts.join(" ");

  // ── Negative prompt ──────────────────────────────────────────────────────────
  const negativeBase = [
    "collage", "split panels", "panel borders", "dividing lines",
    "multiple different characters", "inconsistent appearance between panels",
    "different face between panels", "different hair between panels",
    "different eye color between panels", "different skin tone between panels",
    "text labels", "arrows", "watermarks", "UI elements", "grid lines",
    "blurry regions", "out of frame", "cropped limbs", "low resolution",
  ];

  const negativePrompt = [...negativeBase, ...renderingData.negative].join(", ");

  return { finalPrompt, negativePrompt };
}

// ─────────────────────────────────────────────────────────────────────────────
// DISPLAY NAME BUILDER
// ─────────────────────────────────────────────────────────────────────────────

function buildDisplayName(TYPE, features = {}) {
  const typeLabel = TYPE.charAt(0) + TYPE.slice(1).toLowerCase();

  const directName = features?.name || features?.characterName || features?.productName || features?.locationName;
  if (directName?.trim()) {
    return `${typeLabel}: ${directName.trim().substring(0, 50)}`;
  }

  if (TYPE === "CHARACTER") {
    const identity = features?.identity || {};
    const parts = [identity.race, identity.gender, identity.characterType].filter(Boolean);
    if (parts.length) return `${typeLabel}: ${parts.map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(" ")}`;
  }

  if (TYPE === "PRODUCT") {
    const parts = [features?.color, features?.material, features?.type].filter(Boolean);
    if (parts.length) return `${typeLabel}: ${parts.join(" ")}`;
  }

  if (TYPE === "LOCATION") {
    const parts = [features?.biome, features?.style, features?.type].filter(Boolean);
    if (parts.length) return `${typeLabel}: ${parts.join(" ")}`;
  }

  return `${typeLabel} Sheet`;
}

// ─────────────────────────────────────────────────────────────────────────────
// ElementSheetTreatment CLASS
// ─────────────────────────────────────────────────────────────────────────────

export class ElementSheetTreatment extends BaseGenerateImageTreatment {

  constructor({ promptService, models, storageService, db, dnaTreatment, walletService = null }) {
    super({ promptService, models, storageService, db, walletService });
    this.dnaTreatment = dnaTreatment;
    this.refProcessor = new ReferenceProcessor({ storageService, db });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 1. PREPARE
  // ─────────────────────────────────────────────────────────────────────────

  async prepare(input) {
    const {
      sheetType  = "CHARACTER",
      prompt     = "",
      features,
      references = [],
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

    const defaults       = SHEET_DEFAULTS[TYPE];
    const model_name     = defaults.model_name;
    const ratio          = defaults.ratio;
    const quality        =defaults.quality;
    const steps          = defaults.steps;
    const guidance_scale = defaults.guidance_scale;

    const displayName = buildDisplayName(TYPE, features);

    const input_assets = await this.refProcessor.process(
      references, userId, project_id, null, "uploads"
    );

    const task = await this._runPrepare({
      prompt,
      prompt_optimise: null,
      display_name:    displayName,
      model_name,
      workflow_type:   "ELEMENT_SHEET",
      ratio,
      quality,
      steps,
      guidance_scale,
      count:           1,
      userId,
      project_id,
      session_id:      input.session_id ?? null,
      input_assets,
      stepId:          "CAE",
      extraTaskFields: {
        sheetType:   TYPE,
        rawFeatures: features,
        userText:    prompt,
        dnaPayload: this.dnaTreatment ? {
          name:            features?.name || `${features?.identity?.characterType || TYPE} Sheet`,
          type:            TYPE,
          features,
          userDescription: prompt,
        } : null,
      },
    });

    return task;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 2. OPTIMIZE PROMPT  (no LLM — pure cinematic builder)
  // ─────────────────────────────────────────────────────────────────────────

  async optimizePrompt(task) {
    const { rawFeatures = {}, userText = "", mediaIds = [] } = task;

    const { finalPrompt, negativePrompt } = buildCharacterPrompt(rawFeatures, userText);

    this._log("info", `✅ Cinematic prompt built (no LLM): ${finalPrompt.slice(0, 120)}…`);
    console.log("\n🎬 [ElementSheetTreatment] FINAL PROMPT:\n", finalPrompt);
    console.log("\n🚫 [ElementSheetTreatment] NEGATIVE PROMPT:\n", negativePrompt);

    // Safety check
    const safety = await this.promptService.checkPrompt(finalPrompt);
    if (!safety.safe) {
      for (const id of mediaIds) {
        await markMediaFailed(this.db, id, safety.reason);
      }
      throw new Error(`Prompt rejected: ${safety.reason}`);
    }

    return { finalPrompt, finalNegative: negativePrompt };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 3. RUN
  // ─────────────────────────────────────────────────────────────────────────

  async run(task, optimizeResult) {
    const {
      userId,
      model_name,
      ratio, quality, size, width, height,
      steps, guidance_scale,
      input_assets,
      configId,
      workflows,
      mediaIds,
      dnaPayload,
    } = task;

    const { finalPrompt, finalNegative } = optimizeResult;

    const provider  = this._resolveProvider(model_name, input_assets);
    const workflow  = workflows[0];
    const mediaId   = mediaIds[0];

    try {
      const sourceAsset = input_assets?.find(a => ["source", "base"].includes(a.role))
        ?? input_assets?.[0];

      const form = {
        prompt:          finalPrompt,
        negativePrompt:  finalNegative,
        negative_prompt: finalNegative,
        ratio, quality, size, width, height,
        steps:          steps          ?? 40,
        guidanceScale:  guidance_scale ?? 9.0,
        guidance_scale: guidance_scale ?? 9.0,
        image:          sourceAsset?.url ?? null,
        image_url:      sourceAsset?.url ?? null,
        references:     input_assets,
      };

      const payload   = this._buildPayload(provider, form);
      const result    = await provider.generate(payload);
      const outputUrl = extractOutputUrl(result);

      const fileName = `${userId}/generations/${workflow.id}_${Date.now()}.png`;
      const fileUrl  = await this.storageService.uploadFromUrl(fileName, outputUrl);

      await this.db.media.updateFields(mediaId, {
        url:    fileUrl,
        width:  result.width  ?? width  ?? 1536,
        height: result.height ?? height ?? 1024,
      });
      await markMediaStatus(this.db, mediaId, "success");

      this._log("info", `✅ Sheet generated | configId:${configId}`);

      if (this.dnaTreatment && dnaPayload) {
        this.dnaTreatment
          .run({
            workflow_id: workflow.id,
            features:    dnaPayload.features,
            description: dnaPayload.userDescription,
          })
          .catch(err => this._log("error", `DNA generation failed: ${err.message}`));
      }

      return { configId, mediaId, workflowId: workflow.id, succeeded: 1, failed: 0 };

    } catch (err) {
      this._log("error", `Sheet generation failed: ${err.message}`);
      await markMediaFailed(this.db, mediaId, err);
      throw err;
    }
  }
}