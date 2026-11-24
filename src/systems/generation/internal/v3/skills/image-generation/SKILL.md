---
name: image-generation
description: Prepare final English prompt for AI still image generation
json: true
---
Prepare a clear, cohesive final English prompt optimized for AI still image generation while applying all other active skills.

Rules:
- Keep the scene grounded in the user's request without inventing unrequested objects or characters.
- Preserve every `@Name` tag, every `@image1..@imageN` visual reference tag, and any `[Reference Guide]` block exactly as written.
- Return the final English still-image prompt in the JSON `"prompt"` field.
