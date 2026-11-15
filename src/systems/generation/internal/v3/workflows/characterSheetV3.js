/**
 * CharacterSheetV3 Workflow Blueprint (`character-sheet-v3`)
 *
 * ComfyUI-Style Linear 4-Node DAG:
 *   1) [resolve_refs]   (`base.resolve_references`)
 *   2) [llm_enrich]     (`base.llm` with skills: ["system-safety", "translation", "character-description"])
 *   3) [generate_sheet] (`base.image_generate`)
 *   4) [save_media]     (`base.save_media`)
 */
export const characterSheetV3 = Object.freeze({
  id: "character-sheet-v3",
  aliases: Object.freeze(["character-sheet-v1", "characterSheet"]),
  name: "Character Turnaround Sheet V3",
  version: "3.0.0",
  category: "character",
  mediaType: "image",
  mediaRole: "sheet",
  saveType: "character_sheet",
  requiredInputs: Object.freeze(["prompt"]),
  contract: Object.freeze({
    id: "character-sheet-v3",
    aliases: Object.freeze(["character-sheet-v1", "characterSheet"]),
    mediaType: "image",
    mediaRole: "sheet",
    saveType: "character_sheet",
    requiredInputs: Object.freeze(["prompt"]),
  }),
  description:
    "Declarative 4-node V3 character turnaround sheet pipeline: reference resolution, single-call LLM safety check + translation + 3-view character description, sheet generation, and explicit media persistence.",

  nodes: [
    {
      id: "resolve_refs",
      type: "base.resolve_references",
      inputs: {
        prompt: { fromInput: "prompt" },
        references: { fromInput: "references", default: [] },
        characters: { fromInput: "characters", default: [] },
        elements: { fromInput: "elements", default: [] },
        template_suffix:
          "Full body 3-view character turnaround sheet: front view, side profile view, and back view on neutral studio background",
      },
    },
    {
      id: "llm_enrich",
      type: "base.llm",
      inputs: {
        prompt: { fromNode: "resolve_refs", output: "prepared_prompt" },
        reference_guide: { fromNode: "resolve_refs", output: "reference_guide" },
        images: { fromNode: "resolve_refs", output: "reference_urls" },
        skills: ["system-safety", "translation", "character-description"],
      },
    },
    {
      id: "generate_sheet",
      type: "base.image_generate",
      inputs: {
        model: { fromInput: "model", default: "gpt-image-2" },
        prompt: { fromNode: "llm_enrich", output: "final_prompt" },
        reference_urls: { fromNode: "resolve_refs", output: "reference_urls" },
        aspect_ratio: "16:9",
        width: 1344,
        height: 768,
        count: 1,
      },
    },
    {
      id: "save_media",
      type: "base.save_media",
      inputs: {
        media_id: { fromInput: "media_id" },
        asset_url: { fromNode: "generate_sheet", output: "image_url" },
        final_prompt: { fromNode: "llm_enrich", output: "final_prompt" },
        character_description: { fromNode: "llm_enrich", output: "character_description" },
        metadata: { fromNode: "generate_sheet", output: "metadata" },
        media_role: "sheet",
        save_type: "character_sheet",
      },
    },
  ],
});

export default characterSheetV3;
