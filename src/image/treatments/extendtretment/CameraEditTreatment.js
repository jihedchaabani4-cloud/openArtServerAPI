import { BaseEditTreatment } from "../basetretment/BaseEditTreatment.js";
import { resolveReferences }  from "../../utils/resolveReferences.js";

// ─── Camera helpers ────────────────────────────────────────────────────────

/**
 * rotation: 0 → 360
 *   0   = camera in front
 *   90  = camera on the right
 *   180 = camera behind
 *   270 = camera on the left
 */
const getRotationText = (r) => {
  const angle = ((r % 360) + 360) % 360;

  if (angle <= 20 || angle >= 340)  return "camera positioned directly in front of the subjects";
  if (angle > 20  && angle <= 60)   return "camera positioned to the front-right of the subjects";
  if (angle > 60  && angle <= 120)  return "camera positioned to the right side of the subjects";
  if (angle > 120 && angle <= 160)  return "camera positioned to the rear-right of the subjects";
  if (angle > 160 && angle <= 200)  return "camera positioned directly behind the subjects";
  if (angle > 200 && angle <= 240)  return "camera positioned to the rear-left of the subjects";
  if (angle > 240 && angle <= 300)  return "camera positioned to the left side of the subjects";
  if (angle > 300 && angle < 340)   return "camera positioned to the front-left of the subjects";

  return "camera positioned directly in front of the subjects";
};

/**
 * tilt: -90 → +90
 *   0   = eye level
 *  +90  = bird's eye
 *  -90  = worm's eye
 */
const getTiltText = (t) => {
  if (t === 0)               return "camera at eye level";
  if (t > 0  && t <= 20)    return "camera slightly above, mild downward angle";
  if (t > 20 && t <= 50)    return "camera at high angle, looking down at subjects";
  if (t > 50 && t <= 75)    return "camera at steep high angle, nearly top-down";
  if (t > 75)                return "camera at bird's eye view, looking straight down";
  if (t < 0  && t >= -20)   return "camera slightly below, mild upward angle";
  if (t < -20 && t >= -50)  return "camera at low angle, looking up at subjects";
  if (t < -50 && t >= -75)  return "camera at steep low angle";
  if (t < -75)               return "camera at worm's eye view, looking straight up";
  return "camera at eye level";
};

/**
 * zoom: 1 → 5
 *   1 = extreme close-up
 *   5 = very wide
 */
const getZoomText = (z) => {
  if (z <= 1.5) return "extreme close-up, faces filling the frame";
  if (z <= 2.5) return "close-up shot, heads and shoulders visible";
  if (z <= 3.5) return "medium shot, upper bodies visible";
  if (z <= 4.5) return "wide shot, full bodies and environment visible";
  return "very wide establishing shot, full scene visible";
};

// ─── Angle detection ───────────────────────────────────────────────────────

const isRearView = (r) => {
  const angle = ((r % 360) + 360) % 360;
  return angle > 120 && angle < 240;
};

const isSideView = (r) => {
  const angle = ((r % 360) + 360) % 360;
  return (angle > 60 && angle <= 120) || (angle >= 240 && angle < 300);
};

// ─── 🔥 PROMPT BUILDER ────────────────────────────────────────────────────

const buildCameraPrompt = (rotation, tilt, zoom) => {
  const rear = isRearView(rotation);
  const side = isSideView(rotation);

  const parts = [

    // 📍 Camera position
    getRotationText(rotation),
    getTiltText(tilt),
    getZoomText(zoom),

    // 🧊 FROZEN SCENE — el fix el asasi
    "the entire scene is completely frozen and static",
    "nobody in the scene moves, turns, or changes position",
    "all subjects remain looking in their original direction",
    "subjects do NOT turn toward the camera",
    "subjects do NOT react to the camera",
    "gaze direction of all subjects stays unchanged",

    // 📷 Only camera moved
    "ONLY the camera has moved to a new position",
    "this is a different camera angle of the exact same frozen moment",
    "viewpoint change only, scene content unchanged",

    // 👀 What we see
    rear
      ? "we now see the backs of the subjects, faces not visible"
      : side
      ? "we now see the subjects from the side profile"
      : "we now see the subjects facing forward naturally",

    // 👗 Preserve appearance
    "keep exact same clothing, hairstyle, and physical appearance of all subjects",

    // 🚫 Hard rules
    "do NOT rotate any person",
    "do NOT make any subject look at the camera",
    "do NOT change any face direction",
    "do NOT alter the background or environment",
    "do NOT change the lighting",
    "do NOT add or remove any person",

    // ✅ Quality
    "photorealistic, cinematic, high detail, sharp focus",
  ];

  return parts.join(",\n");
};

// ─── ❌ NEGATIVE PROMPT ────────────────────────────────────────────────────

const NEGATIVE_PROMPT = [
  // 🔥 Subject movement — el fix el kbir
  "subjects turning around",
  "subjects looking at camera",
  "face turned toward camera",
  "characters rotating",
  "gaze direction change",
  "subjects reacting to camera",
  "people moving",
  "pose change",
  "body movement",
  "head rotation",

  // Identity drift
  "different person",
  "different face",
  "identity change",
  "face replacement",
  "new person",

  // Appearance drift
  "different clothes",
  "different hairstyle",
  "outfit change",

  // Scene drift
  "background change",
  "environment change",
  "different lighting",
  "object movement",
  "new composition",

  // Quality
  "distorted face",
  "deformed body",
  "blurry",
  "low quality",
  "unrealistic",
].join(", ");

// ─── CameraTreatment ──────────────────────────────────────────────────────

export class CameraTreatment extends BaseEditTreatment {

  async prepare({
    rotation = 0,     // 0 → 360
    tilt = 0,         // -90 → +90
    zoom = 3,         // 1 → 5

    model_name = "gpt-image-2",
    ratio,
    quality = "high",

    seed = 123456,
    steps = 40,
    guidance_scale = 14,

    reference_workflow_ids = [],

    userId,
    project_id,
    session_id,
    workflow_id,
  }) {

    if (!userId || !project_id || !session_id || !workflow_id) {
      throw new Error("Missing required IDs");
    }

    // ── Clamp ranges ──────────────────────────────────────────────────────
    rotation = Math.min(360, Math.max(0, rotation));
    tilt     = Math.min(90,  Math.max(-90, tilt));
    zoom     = Math.min(5,   Math.max(1, zoom));

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
      ratio: ratio || references.find(r => r.is_base)?.aspect_ratio || "1:1",
      quality,
      seed,
      steps,
      guidance_scale,
      negative_prompt: NEGATIVE_PROMPT,
      userId,
      project_id,
      session_id,
      workflow_id,
      stepId: "CAE_PRO",
    });

    task.rotation = rotation;
    task.tilt     = tilt;
    task.zoom     = zoom;

    return task;
  }

  // ──────────────────────────────────────────────────────────────────────

  async optimizePrompt(task) {

    const rotation = task.rotation ?? 0;
    const tilt     = task.tilt     ?? 0;
    const zoom     = task.zoom     ?? 3;

    const rear = isRearView(rotation);
    const side = isSideView(rotation);

    const cameraPrompt = buildCameraPrompt(rotation, tilt, zoom);

    task.prompt = `
${cameraPrompt}.

Use the provided source image as the fixed reference.
This is the SAME scene captured from a different camera position.
The subjects are frozen — they did not move, turn, or change.
${rear
  ? "The camera moved behind them — only their backs are visible, faces are hidden."
  : side
  ? "The camera moved to their side — only their profile is visible."
  : "The camera moved in front — their natural forward-facing posture is visible."
}
Reproduce all scene details, clothing, and environment exactly.
Only the camera angle is different.
`.trim();

    console.log("🎥 Camera params:", {
      rotation,
      tilt,
      zoom,
      rear,
      side,
      rotationText: getRotationText(rotation),
      tiltText: getTiltText(tilt),
      zoomText: getZoomText(zoom),
    });

    console.log("📝 FINAL PROMPT:\n", task.prompt);

    return super.optimizePrompt(task);
  }
}
