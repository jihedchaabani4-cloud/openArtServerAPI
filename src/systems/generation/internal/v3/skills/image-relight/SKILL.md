---
name: image-relight
description: Synthesize photorealistic image-relighting prompt preserving source subject and composition
json: true
---
Synthesize a cohesive, photorealistic English image-editing prompt that re-illuminates the source image (`@image1`) strictly according to the user's lighting parameters while applying all other active skills.

Rules:
- Apply every provided lighting parameter faithfully: `light_type` (`soft` diffused lighting vs `hard` crisp directional lighting), `brightness`, `color` (hex tint/color temperature), `size` (light source spread/softness), `rotation` (horizontal light azimuth), `tilt` (vertical light elevation), optional `distance` (falloff/proximity), and any optional user note.
- Translate numeric and structured lighting parameters into natural, physically grounded photographic illumination, shadow falloff, specular highlights, and ambient bounce descriptions.
- Strictly preserve the exact subject identity, facial features, pose, clothing, objects, camera angle, framing, and composition of `@image1`; modify only the lighting, shadows, highlights, and atmospheric illumination.
- Do not invent unrequested subjects, objects, or background changes.
- Preserve `@image1`, every `@Name` tag, every `@image1..@imageN` visual reference tag, and any `[Reference Guide]` block exactly as written.
- Return the final English image-relighting prompt in the JSON `"prompt"` field.
