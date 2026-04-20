import { BaseEditTreatment } from "../basetretment/Baseedittreatment .js";

// ─── Camera helpers ────────────────────────────────────────────────────────

const getRotationText = (r) => {
  if (r === 0)               return "front view";
  if (r > 0   && r <= 45)   return "slightly right angle";
  if (r > 45  && r <= 90)   return "right side view";
  if (r > 90  && r <= 135)  return "rear right view";
  if (r > 135)              return "rear view";
  if (r < 0   && r >= -45)  return "slightly left angle";
  if (r < -45 && r >= -90)  return "left side view";
  if (r < -90 && r >= -135) return "rear left view";
  return "rear view";
};

const getTiltText = (t) => {
  if (t === 0)              return "eye level";
  if (t > 0  && t <= 30)   return "slightly high angle";
  if (t > 30 && t <= 60)   return "high angle";
  if (t > 60)              return "bird's eye view";
  if (t < 0  && t >= -30)  return "slightly low angle";
  if (t < -30 && t >= -60) return "low angle";
  return "worm's eye view";
};

const getZoomText = (zoom) => {
  if (zoom <= 2) return "extreme close-up";
  if (zoom <= 4) return "close-up";
  if (zoom <= 6) return "medium shot";
  if (zoom <= 8) return "wide shot";
  return "extreme wide shot";
};

const buildCameraPrompt = (rotation, tilt, zoom) => [
  `${getRotationText(rotation)}, ${getTiltText(tilt)}, ${getZoomText(zoom)}`,
  "same subject, same clothing, same environment, same lighting, same art style",
  "photorealistic, cinematic, natural perspective, high detail, consistent identity",
].join(", ");

// ─── CameraTreatment ──────────────────────────────────────────────────────

export class CameraTreatment extends BaseEditTreatment {

  // ─────────────────────────────────────────────────────────────────────────
  // prepare — params explicites propres à la caméra
  // ─────────────────────────────────────────────────────────────────────────

  async prepare({
    rotation       = 0,
    tilt           = 0,
    zoom           = 6,
    model_name     = "seedream-pro",
    ratio,
    quality,
    seed,
    steps,
    guidance_scale,
    negative_prompt,
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

    // ── Build prompt from camera params ────────────────────────────────────
    const prompt = buildCameraPrompt(rotation, tilt, zoom);
    console.log(`🎥 [CameraTreatment] prompt: "${prompt}"`);

    // ── Fetch latest workflow media as base image ──────────────────────────
    const sourceMedia = await this.db.media.findLatestByWorkflow(workflow_id);
    if (!sourceMedia)     throw new Error(`No media found for workflow ${workflow_id}`);
    if (!sourceMedia.url) throw new Error(`Source media has no final URL yet.`);

    const references = [];
    for (const refWfId of (reference_workflow_ids || [])) {
      const pm = await this.db.workflows.getPrimaryMedia(refWfId);
      if (pm?.url && !references.find(r => r.url === pm.url)) {
        references.push({ url: pm.url, role: "reference", is_base: false });
      }
    }
    
    if (!references.find(r => r.url === sourceMedia.url)) {
      references.unshift({
        url:      sourceMedia.url,
        role:     "source",
        is_base:  true,
      });
    }

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
      userId,
      project_id,
      session_id,
      workflow_id,
      stepId: "CAE",
    });
  }
}