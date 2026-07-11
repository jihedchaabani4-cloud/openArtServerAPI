// ─── Camera helpers ────────────────────────────────────────────────────────

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

const getZoomText = (z) => {
  if (z <= 1.5) return "extreme close-up, faces filling the frame";
  if (z <= 2.5) return "close-up shot, heads and shoulders visible";
  if (z <= 3.5) return "medium shot, upper bodies visible";
  if (z <= 4.5) return "wide shot, full bodies and environment visible";
  return "very wide establishing shot, full scene visible";
};

const isRearView = (r) => {
  const angle = ((r % 360) + 360) % 360;
  return angle > 120 && angle < 240;
};

const isSideView = (r) => {
  const angle = ((r % 360) + 360) % 360;
  return (angle > 60 && angle <= 120) || (angle >= 240 && angle < 300);
};

export const buildCameraPrompt = (rotation, tilt, zoom) => {
  const rear = isRearView(rotation);
  const side = isSideView(rotation);

  const parts = [
    getRotationText(rotation),
    getTiltText(tilt),
    getZoomText(zoom),
    "the entire scene is completely frozen and static",
    "nobody in the scene moves, turns, or changes position",
    "all subjects remain looking in their original direction",
    "subjects do NOT turn toward the camera",
    "subjects do NOT react to the camera",
    "gaze direction of all subjects stays unchanged",
    "ONLY the camera has moved to a new position",
    "this is a different camera angle of the exact same frozen moment",
    "viewpoint change only, scene content unchanged",
    rear ? "we now see the backs of the subjects, faces not visible"
         : side ? "we now see the subjects from the side profile"
         : "we now see the subjects facing forward naturally",
    "keep exact same clothing, hairstyle, and physical appearance of all subjects",
    "do NOT rotate any person",
    "do NOT make any subject look at the camera",
    "do NOT change any face direction",
    "do NOT alter the background or environment",
    "do NOT change the lighting",
    "do NOT add or remove any person",
    "photorealistic, cinematic, high detail, sharp focus",
  ];
  
  const cameraPrompt = parts.join(",\n");
  return `
${cameraPrompt}.

Use the provided source image as the fixed reference.
This is the SAME scene captured from a different camera position.
The subjects are frozen — they did not move, turn, or change.
${rear ? "The camera moved behind them — only their backs are visible, faces are hidden."
       : side ? "The camera moved to their side — only their profile is visible."
       : "The camera moved in front — their natural forward-facing posture is visible."}
Reproduce all scene details, clothing, and environment exactly.
Only the camera angle is different.
`.trim();
};

// ─── Lighting helpers ──────────────────────────────────────────────────────

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

const getVerticalDirection = (elevation) => {
  if (elevation >= 75)            return "straight overhead, top-down lighting";
  if (elevation >= 45)            return "high angle from above";
  if (elevation >= 15)            return "slightly above eye level";
  if (elevation >= -15)           return "at eye level";
  if (elevation >= -45)           return "slightly below eye level, low-angle uplight";
  if (elevation >= -75)           return "steep low angle, dramatic uplight";
  return "straight from below, extreme under-lighting";
};

const getLightPowerDesc = (intensity) => {
  if (intensity <= 10)  return "very weak light source, minimal shadows and falloff";
  if (intensity <= 25)  return "gentle light source, soft shadows";
  if (intensity <= 45)  return "moderate light source, visible shadows";
  if (intensity <= 65)  return "strong light source, well-defined shadows";
  if (intensity <= 85)  return "powerful light source, deep dramatic shadows";
  return "extreme light source, maximum shadow depth and contrast";
};

const getExposureDesc = (brightness) => {
  if (brightness <= 10) return "nearly pitch dark, extreme underexposure";
  if (brightness <= 25) return "very dark, low key, heavily underexposed";
  if (brightness <= 40) return "dark, moody, underexposed atmosphere";
  if (brightness <= 60) return "natural balanced exposure";
  if (brightness <= 75) return "bright, well-lit, slightly overexposed";
  if (brightness <= 90) return "very bright, high key lighting";
  return "extremely bright, maximum overexposure style";
};

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

const getColorDesc = (color) => {
  if (!color || color === "#ffffff" || color === "#fff") {
    return "pure neutral white light, absolutely no color tint";
  }
  const hex = color.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const max = Math.max(r, g, b);
  if (r === max && r > 200 && g < 100 && b < 100) return "deep red light casting a dramatic warm red tint over the entire scene";
  if (r === max && g > 100 && b < 80)              return "warm orange-amber light casting a sunset feel over the entire scene";
  if (r > 200   && g > 150 && b < 80)              return "warm golden light casting a magic hour glow over the entire scene";
  if (g === max && g > 150 && r < 100)             return "green tinted light casting a cool green atmosphere over the entire scene";
  if (b === max && b > 150 && r < 100)             return "cool blue light casting a moonlight or night feel over the entire scene";
  if (b > 180   && r > 150 && g < 100)             return "purple-violet light casting a dramatic cinematic tint over the entire scene";
  if (r > 200   && g > 200 && b < 80)              return "warm yellow light casting a bright warm glow over the entire scene";
  return `colored light with RGB(${r}, ${g}, ${b}) tint applied consistently across the entire scene`;
};

const isBacklight = (angle) => {
  const a = ((angle % 360) + 360) % 360;
  return a > 135 && a < 225;
};

export const buildLightingPrompt = ({ angle, elevation, intensity, type, brightness, color }) => {
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
