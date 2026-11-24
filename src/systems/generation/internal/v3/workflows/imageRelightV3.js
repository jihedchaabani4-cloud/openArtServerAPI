/**
 * ImageRelightV3 Workflow Blueprint (`image-relight-v3`)
 *
 * Zero-LLM 4-Node ComfyUI-Style Linear DAG:
 *   1) [resolve_refs]   (`base.resolve_references`)
 *   2) [build_prompt]   (`base.text_template` — deterministic photographic template with conditional blocks, 0 credits)
 *   3) [generate_image] (`base.image_generate` locked to `nanobana_2` edit operation)
 *   4) [save_media]     (`base.save_media`)
 */
export const IMAGE_RELIGHT_PROMPT_TEMPLATE =
  "{{#has_settings}}Relight this image with a {{light_type}} light (brightness {{brightness}}%, color {{color}}, size {{size}}/100, rotation {{rotation}} degrees, tilt {{tilt}} degrees{{#distance}}, distance {{distance}}/100{{/distance}}), positioned relative to the current camera view{{#rotation_dir}}, shifted {{rotation_abs}} degrees {{rotation_dir}}{{/rotation_dir}}{{#tilt_dir}}, {{tilt_abs}} degrees {{tilt_dir}}{{/tilt_dir}}.{{#distance}} Place the light at distance {{distance}}/100 from the subject.{{/distance}}{{#user_prompt}} Additional direction: {{user_prompt}}.{{/user_prompt}} Preserve the exact subject identity, pose, camera angle, framing, and scene; change only the lighting, shadows, and highlights.{{/has_settings}}{{^has_settings}}{{fallback_text}}{{/has_settings}}";

export const imageRelightV3 = Object.freeze({
  id: "image-relight-v3",
  aliases: Object.freeze(["image-relight", "imageRelight"]),
  name: "Image Relight V3",
  version: "3.1.0",
  category: "image",
  mediaType: "image",
  mediaRole: "output",
  saveType: "workflow_output",
  requiredInputs: Object.freeze(["prompt", "source_image_url"]),
  contract: Object.freeze({
    id: "image-relight-v3",
    aliases: Object.freeze(["image-relight", "imageRelight"]),
    mediaType: "image",
    mediaRole: "output",
    saveType: "workflow_output",
    requiredInputs: Object.freeze(["prompt", "source_image_url"]),
  }),
  description:
    "Zero-LLM 4-node V3 image relighting pipeline: source image reference resolution, deterministic conditional text-template prompt synthesis (0 credits), server-locked nanobana_2 edit execution, and explicit media persistence.",

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
        template: IMAGE_RELIGHT_PROMPT_TEMPLATE,
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

export default imageRelightV3;
