---
name: image-edit
description: Prepare final English prompt for targeted in-place AI image editing
json: true
---
Synthesize a clear, photorealistic English image-editing prompt that applies ONLY the user's requested edits to `@image1` while keeping all other active skills in effect.

Rules:
- Treat `@image1` as the primary source image being edited; preserve untouched subject identity, facial features, body pose, wardrobe, lighting, camera angle, background, and composition unless explicitly changed by the user.
- Apply only the requested additions, removals, replacements, or style changes seamlessly so lighting, shadows, and perspective match `@image1`.
- Preserve every `@Name` tag, every `@image1..@imageN` visual reference tag, and any `[Reference Guide]` block exactly as written.
- Return the final English editing prompt in the JSON `"prompt"` field.
