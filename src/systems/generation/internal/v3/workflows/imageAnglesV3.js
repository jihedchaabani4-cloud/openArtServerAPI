/**
 * ImageAnglesV3 Workflow Blueprint (`image-angles-v3`)
 *
 * Zero-LLM 4-Node ComfyUI-Style Linear DAG:
 *   1) [resolve_refs]   (`base.resolve_references`)
 *   2) [build_prompt]   (`base.text_template` — deterministic cinematography template with conditional blocks, 0 credits)
 *   3) [generate_image] (`base.image_generate` locked to `nanobana_2` edit operation)
 *   4) [save_media]     (`base.save_media`)
 */
export const IMAGE_ANGLES_PROMPT_TEMPLATE =
  "{{#has_settings}}Move the camera relative to the current viewpoint (rotation {{rotation}} degrees, tilt {{tilt}} degrees{{#zoom}}, zoom {{zoom}}/10{{/zoom}}).{{#rotation_dir}} Orbit the camera {{rotation_abs}} degrees {{rotation_dir}} around the subject.{{/rotation_dir}}{{#tilt_dir}} Move the camera {{tilt_abs}} degrees {{tilt_dir}}.{{/tilt_dir}}{{#zoom}} Zoom in {{zoom}}/10 closer toward the subject.{{/zoom}}{{#user_prompt}} Additional direction: {{user_prompt}}.{{/user_prompt}} Preserve the exact subject identity, pose, wardrobe, lighting, and scene continuity; only move the camera viewpoint and naturally reveal newly visible areas.{{/has_settings}}{{^has_settings}}{{fallback_text}}{{/has_settings}}";

export const imageAnglesV3 = Object.freeze({
  id: "image-angles-v3",
  aliases: Object.freeze(["image-angles", "imageAngles"]),
  name: "Image Angles V3",
  version: "3.1.0",
  category: "image",
  mediaType: "image",
  mediaRole: "output",
  saveType: "workflow_output",
  requiredInputs: Object.freeze(["prompt", "source_image_url"]),
  contract: Object.freeze({
    id: "image-angles-v3",
    aliases: Object.freeze(["image-angles", "imageAngles"]),
    mediaType: "image",
    mediaRole: "output",
    saveType: "workflow_output",
    requiredInputs: Object.freeze(["prompt", "source_image_url"]),
  }),
  description:
    "Zero-LLM 4-node V3 virtual camera angle pipeline: source image reference resolution, deterministic conditional text-template prompt synthesis (0 credits), server-locked nanobana_2 edit execution, and explicit media persistence.",

  nodes: [
    {
      id: "resolve_refs",
      type: "base.resolve_references",
      inputs: {
        prompt: { fromInput: "prompt" },
        media_id: { fromInput: "source_image_url" },
        references: { fromInput: "references", default: [] },
      },
    },
    {
      id: "build_prompt",
      type: "base.text_template",
      inputs: {
        template: IMAGE_ANGLES_PROMPT_TEMPLATE,
        variables: { fromInput: "template_vars", default: {} },
        fallback_text: { fromNode: "resolve_refs", output: "prepared_prompt" },
      },
    },
    {
      id: "generate_image",
      type: "base.image_generate",
      inputs: {
        model: "nanobana_2",
        operation: "edit",
        prompt: { fromNode: "build_prompt", output: "text" },
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
        final_prompt: { fromNode: "build_prompt", output: "text" },
        metadata: { fromNode: "generate_image", output: "metadata" },
        media_role: "output",
        save_type: "workflow_output",
      },
    },
  ],
});

export default imageAnglesV3;
