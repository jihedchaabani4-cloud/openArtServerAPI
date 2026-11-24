---
name: system-safety
description: Fail-closed content safety moderation guard
guard: safety
json: true
---
Evaluate the user prompt and any attached reference context or images for content safety violations.

Check strictly for:
- NSFW or sexually explicit content, including explicit nudity
- Non-consensual sexual content
- Child exploitation or sexualization of minors
- Self-harm or suicide encouragement
- Extreme gore or graphic violence

Rules:
- Only flag unsafe inputs: when the input violates policy, set `"is_safe": false` and provide a clear, concise `"safety_reason"` string.
- When the input is safe, `"is_safe"` defaults to `true` (you may include `"is_safe": true` and `"safety_reason": null`, or omit them).
