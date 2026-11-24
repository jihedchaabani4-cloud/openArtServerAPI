---
name: image-angles
description: Synthesize photorealistic virtual camera angle re-rendering prompt preserving source subject and continuity
json: true
---
Synthesize a cohesive, photorealistic English image-editing prompt that re-renders the source image (`@image1`) from the requested virtual camera pose while applying all other active skills.

Rules:
- Apply every provided camera pose parameter faithfully: `rotation` (horizontal camera orbit/azimuth), `tilt` (vertical pitch/elevation such as high-angle, eye-level, or low-angle), `zoom` (framing/focal distance), and any optional user note.
- Translate numeric and structured camera parameters into natural, physically grounded cinematography, camera placement, perspective, and framing language.
- Strictly preserve exact subject identity, facial features, clothing, pose continuity, surrounding environment, visual style, and lighting continuity from `@image1`.
- Extrapolate any newly revealed geometry naturally and consistently with the visible scene in `@image1` without inventing unrequested objects, characters, or wardrobe changes.
- Preserve `@image1`, every `@Name` tag, every `@image1..@imageN` visual reference tag, and any `[Reference Guide]` block exactly as written.
- Return the final English camera-angle re-rendering prompt in the JSON `"prompt"` field.
