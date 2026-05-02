/**
 * ElementSheetTreatment.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Generates three-panel reference sheets (CHARACTER / LOCATION / PRODUCT).
 * NO LLM — prompts built directly from features (deterministic, cinematic).
 *
 * Sheet Types:
 *   CHARACTER → Full-body front | Full-body back | Close-up portrait
 *   PRODUCT   → Front/hero view | Side/detail view | Top or context view
 *   LOCATION  → Wide establishing | Mid-ground detail | Atmospheric/mood close-up
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { BaseGenerateImageTreatment } from "../basetretment/BaseGenerateImageTreatment.js";

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT MODEL SETTINGS PER SHEET TYPE
// ─────────────────────────────────────────────────────────────────────────────

const SHEET_DEFAULTS = {
  CHARACTER: { model_name: "gpt-image-2", ratio: "3:2", quality: "2k", steps: 40, guidance_scale: 9.0 },
  LOCATION:  { model_name: "z_image",     ratio: "3:2", quality: "2k", steps: 30, guidance_scale: 7.5 },
  PRODUCT:   { model_name: "z_image",     ratio: "3:2", quality: "2k", steps: 30, guidance_scale: 7.5 },
};

// ─────────────────────────────────────────────────────────────────────────────
// ██████╗ ██╗  ██╗ █████╗ ██████╗  █████╗  ██████╗████████╗███████╗██████╗
// ██╔════╝██║  ██║██╔══██╗██╔══██╗██╔══██╗██╔════╝╚══██╔══╝██╔════╝██╔══██╗
// ██║     ███████║███████║██████╔╝███████║██║        ██║   █████╗  ██████╔╝
// ██║     ██╔══██║██╔══██║██╔══██╗██╔══██║██║        ██║   ██╔══╝  ██╔══██╗
// ╚██████╗██║  ██║██║  ██║██║  ██║██║  ██║╚██████╗   ██║   ███████╗██║  ██║
//  ╚═════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝ ╚═════╝   ╚═╝   ╚══════╝╚═╝  ╚═╝
// ─────────────────────────────────────────────────────────────────────────────
// CHARACTER FEATURE MAPS
// ─────────────────────────────────────────────────────────────────────────────

const CHARACTER_TYPE_MAP = {
  human:     "human",
  elf:       "elven",
  dwarf:     "dwarven",
  orc:       "orcish",
  troll:     "troll",
  goblin:    "goblin",
  alien:     "alien",
  robot:     "android robot",
  cyborg:    "cyborg",
  demon:     "demonic creature",
  angel:     "angelic being",
  vampire:   "vampire",
  werewolf:  "werewolf",
  zombie:    "undead zombie",
  skeleton:  "skeletal undead",
  mermaid:   "mermaid",
  fairy:     "fairy",
  dragon:    "dragon humanoid",
  ant:       "anthropomorphic ant",
  bee:       "anthropomorphic bee",
  wolf:      "anthropomorphic wolf",
  fox:       "anthropomorphic fox",
  cat:       "anthropomorphic cat",
  bear:      "anthropomorphic bear",
  rabbit:    "anthropomorphic rabbit",
};

const GENDER_MAP = {
  male:           "man",
  female:         "woman",
  nonbinary:      "non-binary person",
  agender:        "agender figure",
  androgynous:    "androgynous figure",
};

const RACE_MAP = {
  african:        "dark-brown skin tone, African features",
  "east-asian":   "East Asian features, fair skin",
  "south-asian":  "South Asian features, warm brown skin",
  european:       "European features, light skin",
  latino:         "Latino/Hispanic features, olive skin",
  "middle-east":  "Middle Eastern features, warm tan skin",
  indigenous:     "Indigenous features, warm copper skin",
  mixed:          "mixed-race features",
};

const BUILD_MAP = {
  slim:       "slim, slender build",
  lean:       "lean, toned build",
  athletic:   "athletic, muscular build",
  average:    "average build",
  stocky:     "stocky, broad build",
  heavy:      "heavy-set build",
  petite:     "petite, small-framed",
  muscular:   "heavily muscular, imposing build",
};

const HEIGHT_MAP = {
  "very-short": "very short stature",
  short:        "short stature",
  average:      "average height",
  tall:         "tall stature",
  "very-tall":  "very tall, towering stature",
};

const HAIR_COLOR_MAP = {
  black:      "jet-black hair",
  brown:      "brown hair",
  blonde:     "blonde hair",
  red:        "red hair",
  auburn:     "auburn hair",
  gray:       "gray hair",
  white:      "white hair",
  silver:     "silver hair",
  blue:       "vivid blue hair",
  green:      "vivid green hair",
  pink:       "vivid pink hair",
  purple:     "vivid purple hair",
  orange:     "vivid orange hair",
  multi:      "multi-colored hair",
  none:       "bald, no hair",
};

const HAIR_TEXTURE_MAP = {
  straight:   "straight",
  wavy:       "wavy",
  curly:      "curly",
  coily:      "tight coily",
  kinky:      "kinky textured",
};

const HAIR_STYLE_MAP = {
  short:      "short-cut",
  medium:     "medium-length",
  long:       "long flowing",
  bun:        "styled in a bun",
  ponytail:   "tied in a ponytail",
  braided:    "braided",
  dreadlocks: "dreadlocked",
  afro:       "full afro",
  mohawk:     "mohawk",
  shaved:     "side-shaved",
  buzz:       "buzz-cut",
};

const EYE_MAP = {
  brown:      "warm brown eyes",
  blue:       "piercing blue eyes",
  green:      "vivid green eyes",
  gray:       "steel-gray eyes",
  hazel:      "hazel eyes",
  amber:      "amber eyes",
  red:        "glowing red eyes",
  purple:     "violet eyes",
  gold:       "golden eyes",
  silver:     "silver eyes",
  heterochromia: "heterochromia (two different colored eyes)",
  white:      "pale white eyes",
  black:      "solid black eyes",
};

const SKIN_CONDITION_MAP = {
  freckles:   "light freckles across the face",
  scars:      "battle scars on face and arms",
  tattoos:    "intricate tattoos visible on skin",
  vitiligo:   "vitiligo patches on skin",
  scales:     "subtle reptilian scales on skin",
  glowing:    "faintly glowing skin",
  markings:   "ritualistic facial markings",
  burns:      "burn scarring on one side of face",
  birthmark:  "distinctive birthmark",
};

const LIMB_MAP = {
  prosthetic: "one prosthetic limb",
  robotic:    "robotic mechanical arm",
  mechanical: "fully mechanical legs",
  wings:      "large feathered wings",
  "demon-wings": "dark leathery demon wings",
  tail:       "long tail",
  tentacles:  "tentacle appendages",
  claws:      "sharp clawed hands",
};

const OUTFIT_MAP = {
  casual:     "casual everyday clothing",
  formal:     "formal business attire",
  fantasy:    "elaborate fantasy armor and robes",
  "sci-fi":   "sleek sci-fi jumpsuit",
  military:   "tactical military gear",
  steampunk:  "steampunk goggles and leather coat",
  cyberpunk:  "neon-accented cyberpunk outfit",
  medieval:   "medieval tunic and cloak",
  royal:      "regal royal garments",
  ninja:      "dark ninja attire",
  punk:       "punk leather jacket and boots",
  sport:      "athletic sportswear",
  swimwear:   "swimwear",
  hazmat:     "hazmat protective suit",
  robe:       "flowing ceremonial robe",
  tribal:     "tribal ceremonial garments",
  suit:       "sleek tailored suit",
  lab:        "white lab coat",
  uniform:    "crisp uniform",
};

const ERA_MAP = {
  ancient:      "ancient world setting",
  medieval:     "medieval setting",
  renaissance:  "Renaissance era",
  victorian:    "Victorian era",
  "early-20th": "early 20th century setting",
  "mid-20th":   "mid-20th century setting",
  modern:       "contemporary modern setting",
  "near-future":"near-future setting",
  "far-future": "far-future sci-fi setting",
  fantasy:      "high fantasy setting",
  "post-apoc":  "post-apocalyptic setting",
};

const RENDERING_STYLE_MAP = {
  "hyper-realistic": {
    style: "hyper-realistic, photorealistic, 8K resolution, cinematic lighting, professional photography",
    quality: "ultra-detailed, sharp focus, award-winning photography",
  },
  anime: {
    style: "anime art style, Studio Ghibli inspired, cel-shaded, vibrant colors",
    quality: "high-quality anime illustration, clean line art",
  },
  "3d-cartoon": {
    style: "3D cartoon render, Pixar/DreamWorks style, smooth shading, expressive features",
    quality: "high-quality 3D render, studio lighting",
  },
  "2d-illustration": {
    style: "2D digital illustration, concept art style, painterly textures",
    quality: "professional concept art, detailed illustration",
  },
  "comic-book": {
    style: "comic book art style, bold ink outlines, halftone shading",
    quality: "professional comic art, dynamic composition",
  },
  "pixel-art": {
    style: "pixel art style, retro game aesthetic, limited color palette",
    quality: "detailed pixel art, clean pixel work",
  },
  "oil-painting": {
    style: "classical oil painting style, rich textures, master-level brushwork",
    quality: "museum-quality fine art, dramatic lighting",
  },
  "watercolor": {
    style: "watercolor illustration, soft edges, translucent layers",
    quality: "delicate watercolor art, professional illustration",
  },
  "dark-fantasy": {
    style: "dark fantasy concept art, moody atmospheric lighting, gritty realism",
    quality: "high-quality dark fantasy art, detailed rendering",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// CHARACTER PROMPT BUILDER
// ─────────────────────────────────────────────────────────────────────────────

function buildCharacterPrompt(features = {}, userText = "") {
  const identity  = features.identity  || {};
  const head      = features.head      || {};
  const details   = features.details   || {};
  const styleKey  = features.renderingStyle || "hyper-realistic";
  const outfitKey = features.outfit    || "casual";
  const eraKey    = features.era       || "modern";

  // ── Identity tokens ───────────────────────────────────────────────────────
  const charType  = CHARACTER_TYPE_MAP[identity.type]   || "human";
  const gender    = GENDER_MAP[identity.gender]         || "person";
  const race      = RACE_MAP[identity.race]             || "";
  const build     = BUILD_MAP[identity.build]           || "";
  const height    = HEIGHT_MAP[identity.height]         || "";
  const age       = identity.age ? `${identity.age}-year-old` : "";

  // ── Head tokens ───────────────────────────────────────────────────────────
  const hairColor   = HAIR_COLOR_MAP[head.hairColor]     || "";
  const hairTexture = HAIR_TEXTURE_MAP[head.hairTexture] || "";
  const hairStyle   = HAIR_STYLE_MAP[head.hairStyle]     || "";
  const hairDesc    = [hairTexture, hairStyle, hairColor].filter(Boolean).join(" ");
  const eyes        = EYE_MAP[head.eyeColor]             || "";

  // ── Detail tokens ─────────────────────────────────────────────────────────
  const skinCond  = SKIN_CONDITION_MAP[details.skinCondition] || "";
  const limbs     = LIMB_MAP[details.limbs]                   || "";

  // ── Outfit & Era ──────────────────────────────────────────────────────────
  const outfit    = OUTFIT_MAP[outfitKey]     || OUTFIT_MAP.casual;
  const era       = ERA_MAP[eraKey]           || ERA_MAP.modern;

  // ── Rendering style ───────────────────────────────────────────────────────
  const rendering = RENDERING_STYLE_MAP[styleKey] || RENDERING_STYLE_MAP["hyper-realistic"];

  // ── Assemble subject description ──────────────────────────────────────────
  const subjectParts = [age, race, build, height, gender, charType]
    .filter(Boolean).join(" ");

  const appearanceParts = [hairDesc && `with ${hairDesc}`, eyes && `${eyes}`]
    .filter(Boolean).join(", ");

  const specialParts = [skinCond, limbs].filter(Boolean).join("; ");

  // ── Three-panel layout description ───────────────────────────────────────
  const panelDesc = [
    "Left panel: full-body front view, character facing directly forward, full figure visible from head to toe, neutral T-pose or relaxed standing pose",
    "Center panel: full-body back view, character turned completely around, showing the back of outfit and hairstyle",
    "Right panel: close-up portrait from chest upward, three-quarter angle, detailed facial features",
  ].join(" | ");

  // ── User text addition ────────────────────────────────────────────────────
  const userAddition = userText ? ` Additional details: ${userText}.` : "";

  const finalPrompt = [
    `A professional character reference sheet of a ${subjectParts}`,
    appearanceParts ? `${appearanceParts}` : null,
    specialParts    ? `with ${specialParts}` : null,
    `wearing ${outfit}`,
    `set in a ${era}`,
    userAddition,
    `Rendered in ${rendering.style}`,
    `Three-panel layout: ${panelDesc}`,
    `White or neutral studio background, consistent lighting across all panels`,
    `Character design sheet, model sheet, turnaround reference, ${rendering.quality}`,
  ].filter(Boolean).join(". ");

  const negativePrompt = [
    "collage, split panels, multiple characters, text labels, watermark, signature, border frame",
    "inconsistent character, different character in each panel, mismatched features",
    "blurry, low quality, deformed, disfigured, extra limbs, missing limbs",
    "bad anatomy, unrealistic proportions, distorted face",
    "cluttered background, busy background, colorful background",
  ].join(", ");

  return { finalPrompt, negativePrompt };
}

// ─────────────────────────────────────────────────────────────────────────────
// ██████╗ ██████╗  ██████╗ ██████╗ ██╗   ██╗ ██████╗████████╗
// ██╔══██╗██╔══██╗██╔═══██╗██╔══██╗██║   ██║██╔════╝╚══██╔══╝
// ██████╔╝██████╔╝██║   ██║██║  ██║██║   ██║██║        ██║
// ██╔═══╝ ██╔══██╗██║   ██║██║  ██║██║   ██║██║        ██║
// ██║     ██║  ██║╚██████╔╝██████╔╝╚██████╔╝╚██████╗   ██║
// ╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚═════╝  ╚═════╝  ╚═════╝   ╚═╝
// ─────────────────────────────────────────────────────────────────────────────
// PRODUCT FEATURE MAPS
// ─────────────────────────────────────────────────────────────────────────────

const PRODUCT_CATEGORY_MAP = {
  // Weapons & Tools
  sword:        "sword",
  axe:          "axe",
  bow:          "bow",
  staff:        "magic staff",
  gun:          "firearm",
  knife:        "knife",
  shield:       "shield",
  hammer:       "hammer",
  spear:        "spear",
  // Electronics & Tech
  phone:        "smartphone",
  laptop:       "laptop computer",
  tablet:       "tablet device",
  headphones:   "headphones",
  watch:        "smartwatch",
  camera:       "camera",
  speaker:      "speaker",
  drone:        "drone",
  robot:        "robot device",
  console:      "gaming console",
  // Vehicles
  car:          "car",
  motorcycle:   "motorcycle",
  bicycle:      "bicycle",
  spaceship:    "spaceship",
  airship:      "airship",
  boat:         "boat",
  tank:         "tank",
  // Furniture & Home
  chair:        "chair",
  table:        "table",
  lamp:         "lamp",
  sofa:         "sofa",
  bed:          "bed",
  shelf:        "shelf",
  // Clothing & Accessories
  armor:        "armor set",
  helmet:       "helmet",
  bag:          "bag",
  shoe:         "shoe",
  hat:          "hat",
  necklace:     "necklace",
  ring:         "ring",
  // Food & Potions
  potion:       "magic potion bottle",
  food:         "food item",
  drink:        "drink",
  // Containers & Objects
  chest:        "treasure chest",
  book:         "book / tome",
  lantern:      "lantern",
  orb:          "mystical orb",
  crystal:      "crystal",
  artifact:     "ancient artifact",
  trophy:       "trophy",
  vase:         "vase",
  // Architecture fragments
  door:         "ornate door",
  window:       "stained-glass window",
  pillar:       "decorative pillar",
};

const PRODUCT_MATERIAL_MAP = {
  metal:      "metal",
  steel:      "polished steel",
  iron:       "dark iron",
  gold:       "gleaming gold",
  silver:     "bright silver",
  bronze:     "aged bronze",
  copper:     "warm copper",
  wood:       "wood",
  oak:        "rich oak wood",
  mahogany:   "dark mahogany wood",
  bamboo:     "bamboo",
  driftwood:  "weathered driftwood",
  stone:      "carved stone",
  marble:     "polished marble",
  granite:    "rough granite",
  obsidian:   "black obsidian",
  crystal:    "clear crystal",
  glass:      "glass",
  plastic:    "plastic",
  rubber:     "rubber",
  fabric:     "woven fabric",
  leather:    "leather",
  fur:        "fur-lined",
  bone:       "bone",
  ivory:      "ivory",
  ceramic:    "ceramic",
  porcelain:  "fine porcelain",
  carbon:     "carbon fiber",
  titanium:   "titanium",
  diamond:    "diamond",
  gem:        "precious gemstones",
  magic:      "glowing enchanted material",
};

const PRODUCT_FINISH_MAP = {
  matte:      "matte finish",
  glossy:     "high-gloss finish",
  satin:      "satin finish",
  brushed:    "brushed texture",
  polished:   "mirror-polished",
  rusted:     "rusted and corroded",
  weathered:  "weathered and worn",
  engraved:   "intricately engraved",
  embossed:   "embossed pattern",
  jeweled:    "jewel-encrusted",
  painted:    "hand-painted detail",
  lacquered:  "lacquered finish",
  forged:     "hand-forged texture",
  aged:       "aged patina",
  clean:      "factory-clean",
  scratched:  "battle-scratched",
};

const PRODUCT_COLOR_MAP = {
  black:      "black",
  white:      "white",
  red:        "deep red",
  blue:       "vibrant blue",
  green:      "forest green",
  gold:       "gold",
  silver:     "silver",
  bronze:     "bronze",
  purple:     "royal purple",
  orange:     "burnt orange",
  pink:       "rose pink",
  teal:       "teal",
  crimson:    "crimson",
  ivory:      "ivory white",
  charcoal:   "charcoal gray",
  "multi":    "multi-colored",
  translucent:"translucent",
  glowing:    "glowing with inner light",
};

const PRODUCT_SIZE_MAP = {
  tiny:       "tiny, palm-sized",
  small:      "small, hand-held",
  medium:     "medium-sized",
  large:      "large",
  massive:    "massive, oversized",
  "life-size":"life-size scale",
};

const PRODUCT_STYLE_MAP = {
  fantasy:    "high fantasy aesthetic",
  "sci-fi":   "science fiction aesthetic",
  medieval:   "medieval aesthetic",
  modern:     "modern contemporary design",
  ancient:    "ancient civilization aesthetic",
  steampunk:  "steampunk aesthetic",
  cyberpunk:  "cyberpunk neon aesthetic",
  tribal:     "tribal/ethnic aesthetic",
  luxury:     "luxury high-end design",
  minimalist: "minimalist clean design",
  baroque:    "baroque ornate design",
  industrial: "industrial utilitarian design",
  organic:    "organic nature-inspired design",
};

// ─────────────────────────────────────────────────────────────────────────────
// PRODUCT PROMPT BUILDER
// ─────────────────────────────────────────────────────────────────────────────

function buildProductPrompt(features = {}, userText = "") {
  const product   = features.product   || {};
  const styleKey  = features.renderingStyle || "hyper-realistic";

  // ── Product tokens ────────────────────────────────────────────────────────
  const category  = PRODUCT_CATEGORY_MAP[product.category] || "object";
  const material  = PRODUCT_MATERIAL_MAP[product.material] || "";
  const finish    = PRODUCT_FINISH_MAP[product.finish]     || "";
  const color     = PRODUCT_COLOR_MAP[product.color]       || "";
  const size      = PRODUCT_SIZE_MAP[product.size]         || "";
  const style     = PRODUCT_STYLE_MAP[product.style]       || "";
  const name      = product.name ? `named "${product.name}"` : "";

  // ── Rendering style ───────────────────────────────────────────────────────
  const rendering = RENDERING_STYLE_MAP[styleKey] || RENDERING_STYLE_MAP["hyper-realistic"];

  // ── Assemble subject description ──────────────────────────────────────────
  const descParts = [size, color, material, finish, style, category]
    .filter(Boolean).join(" ");

  // ── Three-panel layout ────────────────────────────────────────────────────
  const panelDesc = [
    "Left panel: front hero view, product facing directly forward, full product visible, centered composition",
    "Center panel: side profile view (right side), showing full silhouette and depth, same scale as left panel",
    "Right panel: detail close-up or top-down view highlighting key features, materials, and craftsmanship",
  ].join(" | ");

  const userAddition = userText ? ` Additional details: ${userText}.` : "";

  const finalPrompt = [
    `A professional product reference sheet of a ${descParts}`,
    name ? name : null,
    userAddition,
    `Rendered in ${rendering.style}`,
    `Three-panel product design sheet: ${panelDesc}`,
    `Pure white studio background, neutral soft-box lighting, no shadows on background`,
    `Product design reference, industrial design sheet, ${rendering.quality}`,
    `No text labels, no watermarks, consistent scale across all three panels`,
  ].filter(Boolean).join(". ");

  const negativePrompt = [
    "text labels, annotations, watermark, signature, copyright text",
    "multiple products, collage, inconsistent product between panels",
    "blurry, low quality, deformed, distorted, warped proportions",
    "human hands holding, person in frame, environment background",
    "cluttered background, colorful background, patterned background",
    "bad lighting, harsh shadows, overexposed, underexposed",
  ].join(", ");

  return { finalPrompt, negativePrompt };
}

// ─────────────────────────────────────────────────────────────────────────────
// ██╗      ██████╗  ██████╗ █████╗ ████████╗██╗ ██████╗ ███╗   ██╗
// ██║     ██╔═══██╗██╔════╝██╔══██╗╚══██╔══╝██║██╔═══██╗████╗  ██║
// ██║     ██║   ██║██║     ███████║   ██║   ██║██║   ██║██╔██╗ ██║
// ██║     ██║   ██║██║     ██╔══██║   ██║   ██║██║   ██║██║╚██╗██║
// ███████╗╚██████╔╝╚██████╗██║  ██║   ██║   ██║╚██████╔╝██║ ╚████║
// ╚══════╝ ╚═════╝  ╚═════╝╚═╝  ╚═╝   ╚═╝   ╚═╝ ╚═════╝ ╚═╝  ╚═══╝
// ─────────────────────────────────────────────────────────────────────────────
// LOCATION FEATURE MAPS
// ─────────────────────────────────────────────────────────────────────────────

const LOCATION_BIOME_MAP = {
  // Natural
  forest:       "dense forest",
  jungle:       "tropical jungle",
  desert:       "arid desert",
  arctic:       "frozen arctic tundra",
  ocean:        "open ocean",
  beach:        "sandy beach coastline",
  mountain:     "mountain range",
  canyon:       "rocky canyon",
  plains:       "open plains",
  swamp:        "murky swamp",
  cave:         "underground cave system",
  volcano:      "volcanic landscape",
  island:       "tropical island",
  underwater:   "underwater realm",
  sky:          "clouds and sky",
  space:        "outer space",
  // Urban & Built
  city:         "modern city",
  village:      "small village",
  town:         "medieval town",
  castle:       "grand castle",
  dungeon:      "dark dungeon",
  ruins:        "ancient ruins",
  temple:       "ancient temple",
  fortress:     "fortified fortress",
  tower:        "tall tower",
  market:       "bustling marketplace",
  harbor:       "harbor and docks",
  cemetery:     "eerie cemetery",
  arena:        "gladiatorial arena",
  palace:       "royal palace",
  // Interior
  tavern:       "rustic tavern interior",
  library:      "grand library",
  lab:          "scientific laboratory",
  forge:        "blacksmith forge",
  throne_room:  "royal throne room",
  prison:       "dark prison cell",
  chamber:      "mystical chamber",
  // Fantastical
  magic_realm:  "magical floating realm",
  void:         "dark void dimension",
  dream:        "surreal dreamscape",
  crystal_cave: "crystal-filled cave",
  enchanted_forest: "enchanted glowing forest",
  underworld:   "dark underworld",
  heaven:       "luminous celestial realm",
};

const LOCATION_ARCH_STYLE_MAP = {
  // Historical
  ancient_egyptian:   "ancient Egyptian architecture",
  ancient_greek:      "ancient Greek architecture",
  ancient_roman:      "ancient Roman architecture",
  medieval:           "medieval Gothic architecture",
  renaissance:        "Renaissance architecture",
  victorian:          "Victorian architecture",
  // Fantasy
  high_fantasy:       "high fantasy architecture with sweeping arches",
  dark_fantasy:       "dark fantasy ominous architecture",
  elven:              "elven organic curved architecture",
  dwarven:            "dwarven carved stone architecture",
  orcish:             "brutalist orcish architecture",
  // Modern & Future
  modern:             "modern glass and steel architecture",
  brutalist:          "brutalist concrete architecture",
  minimalist:         "minimalist clean architecture",
  futuristic:         "sleek futuristic architecture",
  cyberpunk:          "cyberpunk neon-lit architecture",
  biopunk:            "biopunk organic grown architecture",
  // Cultural
  japanese:           "traditional Japanese architecture",
  chinese:            "traditional Chinese architecture",
  arabic:             "ornate Arabic architecture",
  aztec:              "Aztec stepped-pyramid architecture",
  viking:             "Viking longhouse architecture",
  indian:             "Mughal Indian architecture",
  // Other
  steampunk:          "steampunk brass-and-pipes architecture",
  post_apocalyptic:   "post-apocalyptic salvaged architecture",
  underwater_arch:    "underwater domed architecture",
  floating:           "floating sky architecture",
};

const LOCATION_WEATHER_MAP = {
  sunny:        "bright sunny day, clear blue sky",
  cloudy:       "overcast cloudy sky",
  stormy:       "dramatic stormy sky, dark clouds",
  rainy:        "heavy rainfall, wet surfaces",
  foggy:        "thick atmospheric fog",
  snowy:        "snowfall, snow-covered ground",
  blizzard:     "blinding blizzard conditions",
  thunderstorm: "lightning storm, electric atmosphere",
  misty:        "light morning mist",
  dry:          "dry heat haze",
  windy:        "strong winds, moving foliage",
  magical:      "magical floating particles in the air",
  aurora:       "aurora borealis in the sky",
};

const LOCATION_LIGHTING_MAP = {
  golden_hour:  "golden hour warm sunlight",
  blue_hour:    "blue hour twilight",
  midday:       "harsh midday overhead sun",
  dawn:         "soft pink dawn light",
  dusk:         "deep orange dusk",
  night:        "dark night scene, moonlight",
  moonlit:      "silver moonlight",
  torchlight:   "warm flickering torchlight",
  candlelight:  "soft candlelit glow",
  neon:         "vivid neon artificial lighting",
  magical_glow: "ethereal magical glow",
  underwater_light: "caustic underwater light patterns",
  fire_lit:     "dramatic firelight",
  studio:       "neutral even lighting",
  volumetric:   "dramatic volumetric light rays",
};

const LOCATION_SCALE_MAP = {
  interior:     "intimate interior space",
  street:       "street-level view",
  plaza:        "open plaza or courtyard",
  district:     "district-level view",
  city:         "cityscape view",
  aerial:       "aerial bird's-eye view",
  landscape:    "sweeping landscape panorama",
  planetary:    "planetary scale, seen from orbit",
};

const LOCATION_ERA_MAP = {
  prehistoric:  "prehistoric ancient era",
  ancient:      "ancient civilization era",
  medieval:     "medieval dark ages",
  renaissance:  "Renaissance period",
  industrial:   "industrial revolution era",
  modern:       "contemporary modern era",
  "near-future": "near-future setting",
  "far-future":  "far-future advanced civilization",
  "post-apoc":   "post-apocalyptic ruined civilization",
  fantasy:       "timeless high fantasy era",
};

const LOCATION_MOOD_MAP = {
  serene:       "peaceful, serene atmosphere",
  foreboding:   "dark, foreboding atmosphere",
  mysterious:   "mysterious, secretive atmosphere",
  majestic:     "grand, majestic atmosphere",
  desolate:     "lonely, desolate atmosphere",
  lively:       "bustling, lively atmosphere",
  sacred:       "sacred, spiritual atmosphere",
  dangerous:    "tense, dangerous atmosphere",
  magical:      "wonder-filled magical atmosphere",
  abandoned:    "abandoned, forgotten atmosphere",
  festive:      "festive, celebratory atmosphere",
  melancholic:  "melancholic, sorrowful atmosphere",
};

// ─────────────────────────────────────────────────────────────────────────────
// LOCATION PROMPT BUILDER
// ─────────────────────────────────────────────────────────────────────────────

function buildLocationPrompt(features = {}, userText = "") {
  const location  = features.location  || {};
  const styleKey  = features.renderingStyle || "hyper-realistic";

  // ── Location tokens ───────────────────────────────────────────────────────
  const biome     = LOCATION_BIOME_MAP[location.biome]          || "landscape";
  const archStyle = LOCATION_ARCH_STYLE_MAP[location.archStyle] || "";
  const weather   = LOCATION_WEATHER_MAP[location.weather]      || "clear sky";
  const lighting  = LOCATION_LIGHTING_MAP[location.lighting]    || "natural lighting";
  const scale     = LOCATION_SCALE_MAP[location.scale]          || "landscape view";
  const era       = LOCATION_ERA_MAP[location.era]              || "";
  const mood      = LOCATION_MOOD_MAP[location.mood]            || "";
  const name      = location.name ? `called "${location.name}"` : "";

  // ── Rendering style ───────────────────────────────────────────────────────
  const rendering = RENDERING_STYLE_MAP[styleKey] || RENDERING_STYLE_MAP["hyper-realistic"];

  // ── Assemble subject description ──────────────────────────────────────────
  const coreParts = [era, archStyle, biome].filter(Boolean).join(" ");
  const atmosParts = [weather, lighting, mood].filter(Boolean).join(", ");

  // ── Three-panel layout ────────────────────────────────────────────────────
  const panelDesc = [
    "Left panel: wide establishing shot, full panoramic view of the location, showing overall scale and environment",
    "Center panel: mid-ground view focusing on key architectural or natural features, human-scale perspective",
    "Right panel: atmospheric detail close-up — texture, material, unique element, or mood-defining feature of the location",
  ].join(" | ");

  const userAddition = userText ? ` Additional details: ${userText}.` : "";

  const finalPrompt = [
    `A professional location reference sheet of a ${coreParts}`,
    name ? name : null,
    `Scale: ${scale}`,
    `Atmosphere: ${atmosParts}`,
    userAddition,
    `Rendered in ${rendering.style}`,
    `Three-panel environment concept sheet: ${panelDesc}`,
    `Consistent lighting and color palette across all three panels`,
    `Environment concept art, location design sheet, production design reference, ${rendering.quality}`,
    `No text labels, no watermarks, no UI overlays`,
  ].filter(Boolean).join(". ");

  const negativePrompt = [
    "text labels, annotations, watermark, signature, copyright text, UI overlay",
    "characters, people, figures in the scene (unless essential to scale)",
    "multiple unrelated environments, collage, inconsistent location between panels",
    "blurry, low quality, deformed perspective, bad architecture",
    "oversaturated, garish colors, HDR tone-mapping artifacts",
    "flat 2D map, top-down map, floor plan, blueprint",
  ].join(", ");

  return { finalPrompt, negativePrompt };
}

// ─────────────────────────────────────────────────────────────────────────────
// DISPLAY NAME BUILDER
// ─────────────────────────────────────────────────────────────────────────────

function buildDisplayName(TYPE, features = {}) {
  if (TYPE === "CHARACTER") {
    const identity = features.identity || {};
    const parts = [
      "Character:",
      RACE_MAP[identity.race]?.split(",")[0]       || null,
      GENDER_MAP[identity.gender]                  || null,
      CHARACTER_TYPE_MAP[identity.type]             || null,
    ].filter(Boolean);
    return parts.join(" ").substring(0, 60) || "Character Sheet";
  }

  if (TYPE === "PRODUCT") {
    const product = features.product || {};
    const parts = [
      "Product:",
      product.name                                  || null,
      PRODUCT_COLOR_MAP[product.color]             || null,
      PRODUCT_MATERIAL_MAP[product.material]?.split(" ")[0] || null,
      PRODUCT_CATEGORY_MAP[product.category]       || null,
    ].filter(Boolean);
    return parts.join(" ").substring(0, 60) || "Product Sheet";
  }

  if (TYPE === "LOCATION") {
    const location = features.location || {};
    const parts = [
      "Location:",
      location.name                                      || null,
      LOCATION_ERA_MAP[location.era]?.split(" ")[0]      || null,
      LOCATION_ARCH_STYLE_MAP[location.archStyle]?.split(" ").slice(0, 2).join(" ") || null,
      LOCATION_BIOME_MAP[location.biome]                 || null,
    ].filter(Boolean);
    return parts.join(" ").substring(0, 60) || "Location Sheet";
  }

  return "Element Sheet";
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN CLASS
// ─────────────────────────────────────────────────────────────────────────────

export class ElementSheetTreatment extends BaseGenerateImageTreatment {

  // ─────────────────────────────────────────────────────────
  // 1. PREPARE
  // ─────────────────────────────────────────────────────────

  async prepare(input) {
    const {
      userId,
      project_id,
      session_id,
      sheetType,
      features   = {},
      userText   = "",
      references = [],
    } = input;

    // ── Validate required fields ──────────────────────────────────────────
    if (!userId)     throw new Error("userId is required");
    if (!project_id) throw new Error("project_id is required");

    const TYPE = (sheetType || "").toUpperCase();
    if (!["CHARACTER", "LOCATION", "PRODUCT"].includes(TYPE)) {
      throw new Error(`Invalid sheetType: "${sheetType}". Must be CHARACTER, LOCATION, or PRODUCT.`);
    }

    // ── Model defaults ────────────────────────────────────────────────────
    const defaults = SHEET_DEFAULTS[TYPE];

    // ── Resolve references (reference images) ─────────────────────────────
    const input_assets = (references || [])
      .filter(r => r?.url)
      .map((r, i) => ({
        url:      r.url,
        role:     r.role     || "reference",
        media_id: r.media_id || null,
        is_base:  r.is_base  || false,
      }));

    // ── Display name ──────────────────────────────────────────────────────
    const display_name = buildDisplayName(TYPE, features);

    // ── Prompt placeholder (will be built in optimizePrompt) ──────────────
    // We store raw features in extraTaskFields for use in optimizePrompt
    const promptPlaceholder = display_name;

    return this._runPrepare({
      prompt:         promptPlaceholder,
      prompt_optimise: null,
      display_name,
      model_name:     input.model_name     || defaults.model_name,
      workflow_type:  "ELEMENT_SHEET",
      ratio:          input.ratio          || defaults.ratio,
      quality:        input.quality        || defaults.quality,
      steps:          input.steps          || defaults.steps,
      guidance_scale: input.guidance_scale || defaults.guidance_scale,
      count:          1,
      userId,
      project_id,
      session_id,
      input_assets,
      stepId: "SHEET",
      extraTaskFields: {
        sheetType: TYPE,
        rawFeatures: features,
        userText,
      },
    });
  }

  // ─────────────────────────────────────────────────────────
  // 2. OPTIMIZE PROMPT
  //    Override: deterministic build from features (no LLM)
  // ─────────────────────────────────────────────────────────

  async optimizePrompt(task) {
    const { sheetType, rawFeatures = {}, userText = "", mediaIds = [] } = task;

    let result;

    switch (sheetType) {
      case "CHARACTER":
        result = buildCharacterPrompt(rawFeatures, userText);
        break;
      case "PRODUCT":
        result = buildProductPrompt(rawFeatures, userText);
        break;
      case "LOCATION":
        result = buildLocationPrompt(rawFeatures, userText);
        break;
      default:
        throw new Error(`Unknown sheetType in optimizePrompt: "${sheetType}"`);
    }

    // ── Safety check (still applied even though prompt is deterministic) ──
    if (this.promptService?.checkPrompt) {
      const safety = await this.promptService.checkPrompt(result.finalPrompt);
      if (!safety.safe) {
        for (const id of mediaIds) {
          const { markMediaFailed } = await import("#db/workflowMediaOps.js");
          await markMediaFailed(this.db, id, safety.reason);
        }
        throw new Error(`Prompt rejected by safety check: ${safety.reason}`);
      }
    }

    this._log("info",
      `optimizePrompt | type:${sheetType} | prompt_length:${result.finalPrompt.length}`
    );

    return {
      finalPrompt:    result.finalPrompt,
      finalNegative:  result.negativePrompt,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NAMED EXPORTS (for external use / testing)
// ─────────────────────────────────────────────────────────────────────────────

export {
  buildCharacterPrompt,
  buildProductPrompt,
  buildLocationPrompt,
  buildDisplayName,
  SHEET_DEFAULTS,
  // Feature maps — CHARACTER
  CHARACTER_TYPE_MAP,
  GENDER_MAP,
  RACE_MAP,
  BUILD_MAP,
  HEIGHT_MAP,
  HAIR_COLOR_MAP,
  HAIR_TEXTURE_MAP,
  HAIR_STYLE_MAP,
  EYE_MAP,
  SKIN_CONDITION_MAP,
  LIMB_MAP,
  OUTFIT_MAP,
  ERA_MAP,
  // Feature maps — PRODUCT
  PRODUCT_CATEGORY_MAP,
  PRODUCT_MATERIAL_MAP,
  PRODUCT_FINISH_MAP,
  PRODUCT_COLOR_MAP,
  PRODUCT_SIZE_MAP,
  PRODUCT_STYLE_MAP,
  // Feature maps — LOCATION
  LOCATION_BIOME_MAP,
  LOCATION_ARCH_STYLE_MAP,
  LOCATION_WEATHER_MAP,
  LOCATION_LIGHTING_MAP,
  LOCATION_SCALE_MAP,
  LOCATION_ERA_MAP,
  LOCATION_MOOD_MAP,
  // Shared
  RENDERING_STYLE_MAP,
}