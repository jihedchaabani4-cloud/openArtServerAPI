/**
 * ImageGenerationV3 Workflow Blueprint (`image-generation-v3`)
 *
 * ComfyUI-Style Linear 4-Node DAG:
 *   1) [resolve_refs] (`base.resolve_references`)
 *   2) [llm_process]  (`base.llm` with skills: ["system-safety", "translate"])
 *   3) [generate_image] (`base.image_generate`)
 *   4) [save_media]   (`base.save_media`)
 */
export const imageGenerationV3 = Object.freeze({
  id: "image-generation-v3",
  name: "Image Generation V3",
  version: "3.0.0",
  category: "image",
  description:
    "Declarative 4-node V3 image generation pipeline: reference & tag resolution, single-call LLM safety check + translation, image generation, and explicit media persistence.",

  nodes: [
    {
      id: "resolve_refs",
      type: "base.resolve_references",
      inputs: {
        prompt: { fromInput: "prompt" },
        style: { fromInput: "style", default: "" },
        references: { fromInput: "references", default: [] },
        characters: { fromInput: "characters", default: [] },
        elements: { fromInput: "elements", default: [] },
      },
    },
    {
      id: "llm_process",
      type: "base.llm",
      inputs: {
        prompt: { fromNode: "resolve_refs", output: "prepared_prompt" },
        reference_guide: { fromNode: "resolve_refs", output: "reference_guide" },
        skills: ["system-safety", "translate"],
      },
    },
    {
      id: "generate_image",
      type: "base.image_generate",
      inputs: {
        model: { fromInput: "model", default: "nanobana_2" },
        prompt: { fromNode: "llm_process", output: "final_prompt" },
        reference_urls: { fromNode: "resolve_refs", output: "reference_urls" },
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
        asset_url: { fromNode: "generate_image", output: "image_url" },
        final_prompt: { fromNode: "llm_process", output: "final_prompt" },
        metadata: { fromNode: "generate_image", output: "metadata" },
      },
    },
  ],
});

export default imageGenerationV3;
