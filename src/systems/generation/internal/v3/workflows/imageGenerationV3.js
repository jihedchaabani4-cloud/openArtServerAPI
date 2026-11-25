/**
 * ImageGenerationV3 Workflow Blueprint (`image-generation-v3`)
 *
 * ComfyUI-Style Linear 4-Node DAG:
 *   1) [resolve_refs]   (`base.resolve_references`)
 *   2) [llm_process]    (`base.llm` with skills: ["system-safety", "translate", "image-generation"])
 *   3) [generate_image] (`base.image_generate`)
 *   4) [save_media]     (`base.save_media`)
 */
export const imageGenerationV3 = Object.freeze({
  id: "image-generation-v3",
  aliases: Object.freeze(["image-generation-v1", "imageGeneration"]),
  name: "Image Generation V3",
  version: "3.0.0",
  category: "image",
  requiredInputs: Object.freeze(["prompt"]),
  description:
    "Declarative 4-node V3 image generation pipeline: reference & tag resolution, single-call LLM safety check + translation + image prompt preparation, image generation, and explicit media persistence.",

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
        maxReferences: { fromInput: "max_references" },
      },
    },
    {
      id: "llm_process",
      type: "base.llm",
      inputs: {
        prompt: { fromNode: "resolve_refs", output: "prepared_prompt" },
        skills: ["system-safety", "translate", "image-generation"],
        timeout_ms: 15000,
      },
    },
    {
      id: "generate_image",
      type: "base.image_generate",
      inputs: {
        model: { fromInput: "model", default: "nanobana_2" },
        prompt: { fromNode: "llm_process", output: "text" },
        images: { fromNode: "resolve_refs", output: "reference_urls" },
        parameters: { fromInput: "parameters", default: {} },
      },
    },
    {
      id: "save_media",
      type: "base.save_media",
      inputs: {
        media_id: { fromInput: "media_id" },
        asset_url: { fromNode: "generate_image", output: "image_url" },
        final_prompt: { fromNode: "llm_process", output: "text" },
        metadata: { fromNode: "generate_image", output: "metadata" },
        media_role: "output",
        save_type: "workflow_output",
      },
    },
  ],
});

export default imageGenerationV3;
