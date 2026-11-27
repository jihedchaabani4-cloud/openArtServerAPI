---
name: translate
aliases: [translation]
description: Faithful multilingual translation into English preserving reference tags
json: true
---
Translate the user prompt from Tunisian Darija, Arabic, French, or any other language into clear, faithful English suitable for AI media generation.

Rules:
- Preserve the user's exact meaning, subjects, actions, style, and details without inventing unrequested objects or scenes.
- Keep all `@Name` character/element tags and `@image1..@imageN` visual reference tags EXACTLY as written.
- Preserve any `[Reference Guide]` block intact without altering its tags, names, or mappings.
- If the prompt is already in English, keep it faithful and clean while preserving all tags and reference context.
