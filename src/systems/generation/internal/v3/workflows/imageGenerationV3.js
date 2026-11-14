/**
 * ImageGenerationV3 Workflow Blueprint (`image-generation-v3`)
 *
 * ComfyUI-Style DAG:
 *   [safety_check] ──┐
 *                    ├──> [llm_translate] ──> [prompt_assemble] ──> [image_generate] ──> [save_media]
 *   [resolve_refs] ──┘
 */
export const imageGenerationV3 = Object.freeze({
  id: "image-generation-v3",
  name: "Image Generation V3",
  version: "3.0.0",
  category: "image",
  description:
    "Declarative V3 image generation pipeline with fail-closed safety check, parallel reference resolution, LLM translation, 0-LLM Reference Guide assembly, image generation, and explicit media persistence.",

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
        elements: { fromInput: "elements", default: [] },
      },
    },
    {
      id: "llm_translate",
      type: "base.llm_text",
      inputs: {
        prompt: { fromNode: "safety_check", output: "safe_prompt" },
        system_instruction:
          "Translate the user prompt into clear, faithful English for image generation without adding unrequested objects.",
        json_mode: false,
      },
    },
    {
      id: "prompt_assemble",
      type: "base.prompt_assemble",
      inputs: {
        prompt: { fromNode: "llm_translate", output: "text" },
        entities: { fromNode: "resolve_refs", output: "entities" },
        style: { fromInput: "style", default: "" },
      },
    },
    {
      id: "generate",
      type: "base.image_generate",
      inputs: {
        model: { fromInput: "model", default: "nanobana_2" },
        prompt: { fromNode: "prompt_assemble", output: "final_prompt" },
        reference_urls: { fromNode: "prompt_assemble", output: "reference_urls" },
        aspect_ratio: { fromInput: "aspect_ratio", default: "1:1" },
        width: { fromInput: "width", default: 1024 },
        height: { fromInput: "height", default: 1024 },
        count: { fromInput: "count", default: 1 },
        parameters: { fromInput: "parameters", default: {} },
      },
    },
    {
      id: "save_media",
      type: "base.save_media",
      inputs: {
        media_id: { fromInput: "media_id" },
        asset_url: { fromNode: "generate", output: "image_url" },
        final_prompt: { fromNode: "prompt_assemble", output: "final_prompt" },
        metadata: { fromNode: "generate", output: "metadata" },
      },
    },
  ],
});

export default imageGenerationV3;
