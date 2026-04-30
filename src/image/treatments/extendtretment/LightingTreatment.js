import { BaseEditTreatment } from "../basetretment/BaseEditTreatment.js";
import { resolveReferences }  from "../../utils/resolveReferences.js";

// ─── Lighting helpers ──────────────────────────────────────────────────────

/**
 * angle: 0 → 360
 *   0   = front
 *   90  = right
 *   180 = back (rim/backlight)
 *   270 = left
 */
const getHorizontalDirection = (angle) => {
  const a = ((angle % 360) + 360) % 360;
  if (a <= 22 || a >= 338)        return "directly from the front";
  if (a > 22  && a <= 67)         return "from the front-right";
  if (a > 67  && a <= 112)        return "from the right side";
  if (a > 112 && a <= 157)        return "from the rear-right";
  if (a > 157 && a <= 202)        return "from directly behind (backlight / rim light)";
  if (a > 202 && a <= 247)        return "from the rear-left";
  if (a > 247 && a <= 292)        return "from the left side";
  if (a > 292 && a <  338)        return "from the front-left";
  return "from the front";
};

/**
 * elevation: -90 → +90
 *  +90 = straight overhead
 *    0 = eye level
 *  -90 = straight below
 */
const getVerticalDirection = (elevation) => {
  if (elevation >= 75)            return "straight overhead, top-down lighting";
  if (elevation >= 45)            return "high angle from above";
  if (elevation >= 15)            return "slightly above eye level";
  if (elevation >= -15)           return "at eye level";
  if (elevation >= -45)           return "slightly below eye level, low-angle uplight";
  if (elevation >= -75)           return "steep low angle, dramatic uplight";
  return "straight from below, extreme under-lighting";
};

/**
 * intensity: 0 → 100
 * Controls shadow sharpness and light falloff power
 */
const getLightPowerDesc = (intensity) => {
  if (intensity <= 10)  return "very weak light source, minimal shadows and falloff";
  if (intensity <= 25)  return "gentle light source, soft shadows";
  if (intensity <= 45)  return "moderate light source, visible shadows";
  if (intensity <= 65)  return "strong light source, well-defined shadows";
  if (intensity <= 85)  return "powerful light source, deep dramatic shadows";
  return "extreme light source, maximum shadow depth and contrast";
};

/**
 * brightness: 0 → 100
 * Controls overall scene exposure
 */
const getExposureDesc = (brightness) => {
  if (brightness <= 10) return "nearly pitch dark, extreme underexposure";
  if (brightness <= 25) return "very dark, low key, heavily underexposed";
  if (brightness <= 40) return "dark, moody, underexposed atmosphere";
  if (brightness <= 60) return "natural balanced exposure";
  if (brightness <= 75) return "bright, well-lit, slightly overexposed";
  if (brightness <= 90) return "very bright, high key lighting";
  return "extremely bright, maximum overexposure style";
};

/**
 * Combined mood from intensity + brightness
 * Gives model one clear reading of the overall lighting feel
 */
const getCombinedMood = (intensity, brightness) => {
  const combined = (intensity * 0.4) + (brightness * 0.6);

  if (combined <= 15)  return "very dark noir, barely lit scene";
  if (combined <= 30)  return "dark and moody, dramatic low-key";
  if (combined <= 50)  return "atmospheric, dim and cinematic";
  if (combined <= 65)  return "natural and balanced, everyday lighting";
  if (combined <= 80)  return "bright and energetic, well-lit scene";
  if (combined <= 90)  return "high key, very bright and airy";
  return "maximum brightness, overexposed cinematic style";
};

/**
 * type: "hard" | "soft"
 */
const getLightTypeDesc = (type) => {
  if (type === "hard") return {
    main:    "hard, sharp directional light source like direct sun or spotlight",
    shadows: "sharp-edged, crisp, well-defined shadows with clear boundaries",
    quality: "high contrast, strong separation between lit areas and shadows",
  };
  return {
    main:    "soft, diffused ambient light source like overcast sky or large softbox",
    shadows: "soft-edged, gradual, smooth shadow transitions with no hard lines",
    quality: "low contrast, gentle light wrapping around all surfaces",
  };
};

/**
 * color: hex string
 */
const getColorDesc = (color) => {
  if (!color || color === "#ffffff" || color === "#fff") {
    return "pure neutral white light, absolutely no color tint";
  }

  const hex = color.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const max = Math.max(r, g, b);

  // Named color descriptions
  if (r === max && r > 200 && g < 100 && b < 100) return "deep red light casting a dramatic warm red tint over the entire scene";
  if (r === max && g > 100 && b < 80)              return "warm orange-amber light casting a sunset feel over the entire scene";
  if (r > 200   && g > 150 && b < 80)              return "warm golden light casting a magic hour glow over the entire scene";
  if (g === max && g > 150 && r < 100)             return "green tinted light casting a cool green atmosphere over the entire scene";
  if (b === max && b > 150 && r < 100)             return "cool blue light casting a moonlight or night feel over the entire scene";
  if (b > 180   && r > 150 && g < 100)             return "purple-violet light casting a dramatic cinematic tint over the entire scene";
  if (r > 200   && g > 200 && b < 80)              return "warm yellow light casting a bright warm glow over the entire scene";

  // Fallback
  return `colored light with RGB(${r}, ${g}, ${b}) tint applied consistently across the entire scene`;
};

// ─── Is backlight? ─────────────────────────────────────────────────────────

const isBacklight = (angle) => {
  const a = ((angle % 360) + 360) % 360;
  return a > 135 && a < 225;
};

// ─── 🔥 MAIN PROMPT BUILDER ───────────────────────────────────────────────

const buildLightingPrompt = ({ angle, elevation, intensity, type, brightness, color }) => {
  const horizontal  = getHorizontalDirection(angle);
  const vertical    = getVerticalDirection(elevation);
  const lightPower  = getLightPowerDesc(intensity);
  const exposure    = getExposureDesc(brightness);
  const mood        = getCombinedMood(intensity, brightness);
  const lightType   = getLightTypeDesc(type);
  const colorDesc   = getColorDesc(color);
  const backlight   = isBacklight(angle);

  return `
Completely regenerate the lighting of this scene from scratch.
Ignore and discard ALL original lighting — shadows, highlights, and light sources.
Rebuild the entire lighting of the scene using ONLY the new lighting setup below.

NEW LIGHTING SETUP (apply this completely, from scratch):
- Light source position: ${horizontal}, ${vertical}
- Light type: ${lightType.main}
- Shadow style: ${lightType.shadows}
- Contrast style: ${lightType.quality}
- Light power: ${lightPower} (${intensity}/100)
- Scene exposure: ${exposure} (${brightness}/100)
- Overall mood: ${mood}
- Light color: ${colorDesc}
${backlight ? "- Rim light: apply strong rim lighting around all subject edges, clearly separating subjects from background" : ""}

REGENERATE COMPLETELY:
- All shadows must be fully redrawn from zero, following the new light direction exactly
- All highlights and specular reflections must be recalculated from zero
- All surfaces (skin, fabric, objects, walls, floor) must react physically to the new light
- The entire scene atmosphere and mood must match: ${mood}
- No trace of the original lighting, shadows, or highlights should remain

PRESERVE EXACTLY (do not change anything below):
- Every person's identity, face, and physical features
- All clothing, accessories, hair, and textures
- The entire background, environment, furniture, and objects
- Camera angle, framing, and composition
- Every person's pose and position

QUALITY:
Photorealistic, physically based lighting simulation.
The result must look like the original scene was photographed under these exact lighting conditions.
Cinematic quality, high detail, sharp focus, zero artifacts.
`.trim();
};

// ─── ❌ NEGATIVE PROMPT ────────────────────────────────────────────────────

const NEGATIVE_PROMPT = [
  // Lighting preservation
  "original lighting preserved",
  "mixed lighting sources",
  "partial lighting change",
  "added light on top of original",
  "original shadows visible",
  "original highlights remaining",
  "inconsistent lighting",
  "multiple conflicting light sources",
  "contradictory lighting",

  // Identity
  "different person",
  "changed face",
  "identity drift",
  "new person",

  // Composition
  "different background",
  "changed environment",
  "moved objects",
  "different framing",
  "composition change",
  "camera angle change",

  // Appearance
  "different clothes",
  "outfit change",
  "changed accessories",

  // Quality
  "overexposed face",
  "blown out highlights",
  "crushed blacks",
  "color banding",
  "unrealistic shadows",
  "floating shadows",
  "wrong shadow direction",
  "flat lighting",
  "blurry",
  "low quality",
  "artifacts",
  "unrealistic",
].join(", ");

// ─── LightingTreatment ────────────────────────────────────────────────────

export class LightingTreatment extends BaseEditTreatment {

  async prepare({
    angle      = 0,        // 0 → 360
    elevation  = 30,       // -90 → +90
    intensity  = 50,       // 0 → 100 (light power / shadow strength)
    type       = "soft",   // "soft" | "hard"
    brightness = 60,       // 0 → 100 (scene exposure)
    color      = "#ffffff",

    model_name     = "nano-banana-pro",
    ratio,
    quality,
    seed,
    steps,
    guidance_scale,
    negative_prompt,
    strength,
    reference_workflow_ids = [],

    userId,
    project_id,
    session_id,
    workflow_id,
  }) {

    if (!userId)      throw new Error("userId required");
    if (!project_id)  throw new Error("project_id required");
    if (!session_id)  throw new Error("session_id required");
    if (!workflow_id) throw new Error("workflow_id required");

    // ── Clamp ranges ──────────────────────────────────────────────────────
    angle      = Math.min(360, Math.max(0,   angle));
    elevation  = Math.min(90,  Math.max(-90, elevation));
    intensity  = Math.min(100, Math.max(0,   intensity));
    brightness = Math.min(100, Math.max(0,   brightness));

    // ── Build references from workflows ────────────────────────────────────
    const references = await resolveReferences(this.db, {
      baseWorkflowId:       workflow_id,
      referenceWorkflowIds: reference_workflow_ids,
    });

    // ── Prepare task ──────────────────────────────────────────────────────
    const task = await this._runPrepare({
      prompt: "",
      references,
      model_name,
      ratio: ratio || references.find(r => r.is_base)?.aspect_ratio,
      quality,
      seed,
      steps,
      guidance_scale,
      negative_prompt: negative_prompt || NEGATIVE_PROMPT,
      upscaleScale: null,
      userId,
      project_id,
      session_id,
      workflow_id,
      stepId: "LIT",
    });

    Object.assign(task, { angle, elevation, intensity, type, brightness, color });

    return task;
  }

  // ──────────────────────────────────────────────────────────────────────

  async optimizePrompt(task) {
    const { angle, elevation, intensity, type, brightness, color } = task;

    task.prompt = buildLightingPrompt({ angle, elevation, intensity, type, brightness, color });

    console.log("💡 Lighting params:", {
      angle,
      elevation,
      intensity,
      type,
      brightness,
      color,
      horizontal:    getHorizontalDirection(angle),
      vertical:      getVerticalDirection(elevation),
      mood:          getCombinedMood(intensity, brightness),
      backlight:     isBacklight(angle),
    });

    console.log("📝 FINAL PROMPT:\n", task.prompt);

    return super.optimizePrompt(task);
  }
}