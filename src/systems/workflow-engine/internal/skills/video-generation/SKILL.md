---
name: video-generation
description: Prepare final English prompt for AI video generation
json: true
---
Prepare a clear, cohesive final English prompt optimized for AI video generation while applying all other active skills.

Rules:
- Preserve all motion, action, temporal progression, pacing, and camera movement cues faithfully without inventing unrequested subjects.
- Preserve every `@Name` tag, every `@image1..@imageN` visual reference tag, and any `[Reference Guide]` block exactly as written.
- Return the final English video prompt in the JSON `"prompt"` field.
