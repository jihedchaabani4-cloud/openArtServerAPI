/**
 * CharacterSheetV3 Workflow Blueprint (`character-sheet-v3`)
 *
 * ComfyUI-Style DAG:
 *   [safety_check] ──┐
 *                    ├──> [prompt_assemble] ──> [llm_vision_sheet] ──> [generate_sheet]
 *   [resolve_refs] ──┘                                                       │
 *                                                                            ▼
 *                                            [save_character_sheet] <── [crop_grid]
 */
export const characterSheetV3 = Object.freeze({
  id: "character-sheet-v3",
  name: "Character Turnaround Sheet V3",
  version: "3.0.0",
  category: "character",
  description:
    "Generates a 16:9 3-view character turnaround sheet, splits it into front/side/back panels via custom.crop_character_grid, and persists via custom.save_character_sheet.",

  nodes: [
    {
      id: "safety_check",
      type: "base.safety_check",
      inputs: {
        prompt: { fromInput: "prompt" },
      },
    },
    {
      id: "resolve_refs",
      type: "base.resolve_references",
      inputs: {
        references: { fromInput: "references", default: [] },
        characters: { fromInput: "characters", default: [] },
      },
    },
    {
      id: "prompt_assemble",
      type: "base.prompt_assemble",
      inputs: {
        prompt: { fromNode: "safety_check", output: "safe_prompt" },
        entities: { fromNode: "resolve_refs", output: "entities" },
        template_suffix: "Full body 3-view character turnaround sheet: front view, side profile view, and back view on neutral studio background",
      },
    },
    {
      id: "llm_sheet_director",
      type: "base.llm_vision",
      inputs: {
        prompt: { fromNode: "prompt_assemble", output: "final_prompt" },
        images: { fromNode: "prompt_assemble", output: "reference_urls" },
        system_instruction:
          "Engineer a consistent 3-view studio character turnaround sheet prompt (front, side, back) preserving all anatomical and outfit traits.",
        json_mode: true,
      },
    },
    {
      id: "generate_sheet",
      type: "base.image_generate",
      inputs: {
        model: { fromInput: "model", default: "gpt-image-2" },
        prompt: { fromNode: "llm_sheet_director", output: "text" },
        reference_urls: { fromNode: "prompt_assemble", output: "reference_urls" },
        aspect_ratio: "16:9",
        width: 1344,
        height: 768,
        count: 1,
      },
    },
    {
      id: "crop_grid",
      type: "custom.crop_character_grid",
      inputs: {
        sheet_url: { fromNode: "generate_sheet", output: "image_url" },
        panels: 3,
        width: 1344,
        height: 768,
      },
    },
    {
      id: "save_sheet",
      type: "custom.save_character_sheet",
      inputs: {
        character_id: { fromInput: "character_id" },
        media_id: { fromInput: "media_id" },
        sheet_url: { fromNode: "generate_sheet", output: "image_url" },
        panel_urls: { fromNode: "crop_grid", output: "panel_urls" },
        description: { fromNode: "llm_sheet_director", output: "text" },
        metadata: { fromNode: "generate_sheet", output: "metadata" },
      },
    },
  ],
});

export default characterSheetV3;
