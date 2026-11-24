/**
 * ImageRemoveBackgroundV3 Workflow Blueprint (`image-remove-background-v3`)
 *
 * ComfyUI-Style Direct 2-Node DAG (Zero LLM overhead):
 *   1) [generate_image] (`base.image_generate` with user-selected Bria remove-background model)
 *   2) [save_media]     (`base.save_media`)
 */
export const imageRemoveBackgroundV3 = Object.freeze({
  id: "image-remove-background-v3",
  aliases: Object.freeze(["image-remove-background", "imageRemoveBackground", "remove-background"]),
  name: "Image Remove Background V3",
  version: "3.0.0",
  category: "image",
  mediaType: "image",
  mediaRole: "output",
  saveType: "workflow_output",
  requiredInputs: Object.freeze(["source_image_url"]),
  contract: Object.freeze({
    id: "image-remove-background-v3",
    aliases: Object.freeze(["image-remove-background", "imageRemoveBackground", "remove-background"]),
    mediaType: "image",
    mediaRole: "output",
    saveType: "workflow_output",
    requiredInputs: Object.freeze(["source_image_url"]),
  }),
  description:
    "Direct 2-node V3 background removal pipeline (zero LLM): executes the selected Bria remove-background model directly on the resolved source image and persists the output media.",

  nodes: [
    {
      id: "generate_image",
      type: "base.image_generate",
      inputs: {
        model: { fromInput: "model", default: "bria_remove_background_3_0" },
        operation: "remove_background",
        prompt: { fromInput: "prompt", default: "" },
        images: { fromInput: "source_image_url" },
        parameters: { fromInput: "parameters", default: {} },
      },
    },
    {
      id: "save_media",
      type: "base.save_media",
      inputs: {
        media_id: { fromInput: "media_id" },
        asset_url: { fromNode: "generate_image", output: "image_url" },
        final_prompt: { fromInput: "prompt", default: "" },
        metadata: { fromNode: "generate_image", output: "metadata" },
        media_role: "output",
        save_type: "workflow_output",
      },
    },
  ],
});

export default imageRemoveBackgroundV3;
