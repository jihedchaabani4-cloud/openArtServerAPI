/**
 * ImageAnglesV3 Workflow Blueprint (`image-angles-v3`)
 *
 * Zero-LLM 3-Node Linear DAG:
 *   1) [resolve_refs]   (`base.resolve_references` — preserves `[Reference Guide]` in `prepared_prompt`)
 *   2) [generate_image] (`base.image_generate` locked to `nanobana_2` edit operation)
 *   3) [save_media]     (`base.save_media`)
 *
 * Prompt templates are owned exclusively by Generation's `imageEditContract.js`, which
 * renders the final `prompt` once at intake.
 */
export const imageAnglesV3 = Object.freeze({
  id: "image-angles-v3",
  aliases: Object.freeze(["image-angles", "imageAngles"]),
  name: "Image Angles V3",
  version: "3.2.0",
  category: "image",
  requiredInputs: Object.freeze(["prompt", "source_image_url"]),
  description:
    "Zero-LLM 3-node virtual camera angle pipeline: source image reference resolution, server-locked nanobana_2 edit execution using the pre-rendered prompt, and explicit media persistence.",

  nodes: [
    {
      id: "resolve_refs",
      type: "base.resolve_references",
      inputs: {
        prompt: { fromInput: "prompt" },
        media_id: { fromInput: "source_image_url" },
        references: { fromInput: "references", default: [] },
        allowedMediaTypes: ["image"],
        verify_ownership: { fromInput: "verify_ownership", default: true },
      },
    },
    {
      id: "generate_image",
      type: "base.image_generate",
      inputs: {
        model: "nanobana_2",
        operation: "edit",
        prompt: { fromNode: "resolve_refs", output: "prepared_prompt" },
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
        final_prompt: { fromNode: "resolve_refs", output: "prepared_prompt" },
        metadata: { fromNode: "generate_image", output: "metadata" },
        media_role: "output",
        save_type: "workflow_output",
      },
    },
  ],
});

export default imageAnglesV3;
