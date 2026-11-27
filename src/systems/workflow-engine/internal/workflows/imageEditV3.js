export const imageEditV3 = Object.freeze({
  id: "image-edit-v3",
  aliases: Object.freeze(["image-edit", "imageEdit"]),
  name: "Image Edit V3",
  version: "3.0.0",
  category: "image",
  requiredInputs: Object.freeze(["prompt", "source_image_url"]),
  description:
    "Declarative 4-node in-place image editing pipeline: source image & reference resolution, single-call LLM safety check + translation + targeted edit prompt synthesis, edit-capable image model execution, and explicit media persistence.",

  nodes: [
    {
      id: "resolve_refs",
      type: "base.resolve_references",
      inputs: {
        prompt: { fromInput: "prompt" },
        media_id: { fromInput: "source_image_url" },
        references: { fromInput: "references", default: [] },
        characters: { fromInput: "characters", default: [] },
        elements: { fromInput: "elements", default: [] },
        allowedMediaTypes: ["image"],
        maxReferences: { fromInput: "max_references" },
        verify_ownership: { fromInput: "verify_ownership", default: true },
      },
    },
    {
      id: "llm_process",
      type: "base.llm",
      inputs: {
        prompt: { fromNode: "resolve_refs", output: "prepared_prompt" },
        skills: ["system-safety", "translate", "image-edit"],
        timeout_ms: 15000,
      },
    },
    {
      id: "generate_image",
      type: "base.image_generate",
      inputs: {
        model: { fromInput: "model", default: "nanobana_2" },
        operation: "edit",
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

export default imageEditV3;
