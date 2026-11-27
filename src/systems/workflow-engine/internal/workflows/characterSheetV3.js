export const characterSheetV3 = Object.freeze({
  id: "character-sheet-v3",
  aliases: Object.freeze(["characterSheet"]),
  name: "Character Turnaround Sheet V3",
  version: "3.0.0",
  category: "character",
  requiredInputs: Object.freeze(["prompt"]),
  description:
    "Declarative 5-node character turnaround sheet pipeline: reference resolution, single-call LLM safety check + translation + 3-view character sheet skill, parallel character description extraction and sheet generation, and explicit media persistence.",

  nodes: [
    {
      id: "resolve_refs",
      type: "base.resolve_references",
      inputs: {
        prompt: { fromInput: "prompt" },
        references: { fromInput: "references", default: [] },
        characters: { fromInput: "characters", default: [] },
        elements: { fromInput: "elements", default: [] },
        allowedMediaTypes: ["image"],
        verify_ownership: { fromInput: "verify_ownership", default: true },
      },
    },
    {
      id: "llm_enrich",
      type: "base.llm",
      inputs: {
        prompt: { fromNode: "resolve_refs", output: "prepared_prompt" },
        skills: ["system-safety", "translate", "character-sheet"],
      },
    },
    {
      id: "extract_character_description",
      type: "base.extract",
      inputs: {
        data: { fromNode: "llm_enrich", output: "json" },
        path: "character_description",
        default_value: { fromNode: "llm_enrich", output: "text" },
      },
    },
    {
      id: "generate_sheet",
      type: "base.image_generate",
      inputs: {
        model: { fromInput: "model", default: "gpt-image-2" },
        prompt: { fromNode: "llm_enrich", output: "text" },
        images: { fromNode: "resolve_refs", output: "reference_urls" },
        parameters: { aspect_ratio: "16:9" },
      },
    },
    {
      id: "save_media",
      type: "base.save_media",
      inputs: {
        media_id: { fromInput: "media_id" },
        asset_url: { fromNode: "generate_sheet", output: "image_url" },
        final_prompt: { fromNode: "llm_enrich", output: "text" },
        character_description: { fromNode: "extract_character_description", output: "text" },
        metadata: { fromNode: "generate_sheet", output: "metadata" },
        media_role: "sheet",
        save_type: "character_sheet",
      },
    },
  ],
});

export default characterSheetV3;
