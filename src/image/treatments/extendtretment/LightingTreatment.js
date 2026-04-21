import { BaseEditTreatment } from "../basetretment/BaseEditTreatment.js";

// ─── Lighting helpers ──────────────────────────────────────────────────────

const buildLightingPrompt = ({ angle, elevation, intensity, type, brightness, color }) => {
  const lightType      = type === "hard" ? "sharp, hard directional light" : "soft, diffused ambient light";
  const colorDesc      = color && color !== "#ffffff" ? `with a ${color} color tint` : "with white natural light";
  const brightnessDesc = brightness <= 20 ? "very dim"
                       : brightness <= 40 ? "low"
                       : brightness <= 60 ? "moderate"
                       : brightness <= 80 ? "bright"
                       : "very bright";
  const intensityDesc  = intensity <= 2 ? "subtle"
                       : intensity <= 5 ? "moderate"
                       : intensity <= 8 ? "strong"
                       : "intense";

  let directionDesc;
  if      (elevation >  60) directionDesc = "overhead top-down light";
  else if (elevation >  30) directionDesc = "high-angle light from above";
  else if (elevation > -10) directionDesc = "eye-level side lighting";
  else if (elevation > -40) directionDesc = "low-angle light from below";
  else                      directionDesc = "dramatic under-lighting";

  const horizontalDir = angle < 45  ? "front"
                      : angle < 135 ? "right side"
                      : angle < 225 ? "back"
                      : angle < 315 ? "left side"
                      : "front";

  return `Relighting of the original image — change only the lighting while keeping the same subjects, composition, environment, and style.
Lighting setup:
- Type: ${lightType}
- Direction: ${directionDesc}, from the ${horizontalDir}
- Brightness: ${brightnessDesc} (${brightness}/100)
- Intensity: ${intensityDesc} (${intensity}/10)
- Color: ${colorDesc}

Keep unchanged:
- Same subjects and their identity
- Same clothing and accessories
- Same background and environment
- Same composition and framing
- Same textures and materials

Photorealistic, cinematic relighting, high detail, consistent identity, physically accurate shadows and highlights.`;
};

// ─── LightingTreatment ────────────────────────────────────────────────────

export class LightingTreatment extends BaseEditTreatment {

  // ─────────────────────────────────────────────────────────────────────────
  // prepare — params explicites propres au lighting
  // ─────────────────────────────────────────────────────────────────────────

  async prepare({
    angle,
    elevation,
    intensity,
    type,
    brightness,
    color,
    model_name      = "seedream-pro",
    ratio,
    quality,
    seed,
    steps,
    guidance_scale,
    negative_prompt,
    strength,
    userId,
    project_id,
    session_id,
    workflow_id,
  }) {
    if (!userId)      throw new Error("userId required");
    if (!project_id)  throw new Error("project_id required");
    if (!session_id)  throw new Error("session_id required");
    if (!workflow_id) throw new Error("workflow_id required");

    // ── Build prompt from lighting params ──────────────────────────────────
    const prompt = buildLightingPrompt({ angle, elevation, intensity, type, brightness, color });
    console.log(`💡 [LightingTreatment] prompt built`);

    // ── Fetch latest workflow media as base image ──────────────────────────
    const sourceMedia = await this.db.media.findLatestByWorkflow(workflow_id);
    if (!sourceMedia)     throw new Error(`No media found for workflow ${workflow_id}`);
    if (!sourceMedia.url) throw new Error(`Source media has no final URL yet.`);

    const references = [{
      url:      sourceMedia.url,
      media_id: sourceMedia.id,
      role:     "source",
      is_base:  true,
    }];

    // ── Delegate shared logic to base ──────────────────────────────────────
    return this._runPrepare({
      prompt,
      references,
      model_name,
      ratio,
      quality,
      seed,
      steps,
      guidance_scale,
      negative_prompt,
      upscaleScale: null,
      userId,
      project_id,
      session_id,
      workflow_id,
      stepId: "LIT",
    });
  }
}
