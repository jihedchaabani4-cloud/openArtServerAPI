/**
 * ProductVideo4kV3 Workflow Blueprint (`product-video-4k-v3`)
 *
 * ComfyUI-Style Multi-Stage Product Commercial DAG:
 *   [load_product_media] ──> [remove_bg] ──> [upscale_product] ──┐
 *   [safety_check] ──────────────────────────────────────────────┼──> [vision_motion_prompt]
 *                                                                │            │
 *                                                                ▼            ▼
 *   [save_media] <── [upscale_video_4k] <─────────────────────── [generate_product_video]
 */
export const productVideo4kV3 = Object.freeze({
  id: "product-video-4k-v3",
  name: "Commercial Product Video 4K V3",
  version: "3.0.0",
  category: "video",
  description:
    "Loads product reference image, isolates background, upscales keyframe, synthesizes camera motion prompt via LLM Vision, generates commercial video, upscales to 4K, and saves to Media.",

  nodes: [
    {
      id: "safety_check",
      type: "base.safety_check",
      inputs: {
        prompt: { fromInput: "prompt" },
      },
    },
    {
      id: "load_product_media",
      type: "base.load_media",
      inputs: {
        media_id: { fromInput: "input_media_id" },
      },
    },
    {
      id: "remove_bg",
      type: "base.image_remove_bg",
      inputs: {
        image_url: { fromNode: "load_product_media", output: "media_url" },
      },
    },
    {
      id: "upscale_product",
      type: "base.image_upscale",
      inputs: {
        image_url: { fromNode: "remove_bg", output: "image_url" },
        scale_factor: 2,
      },
    },
    {
      id: "vision_motion_prompt",
      type: "base.llm_vision",
      inputs: {
        prompt: { fromNode: "safety_check", output: "safe_prompt" },
        image_url: { fromNode: "upscale_product", output: "image_url" },
        system_instruction:
          "Analyze the isolated product image and craft a luxury commercial camera motion prompt.",
      },
    },
    {
      id: "generate_product_video",
      type: "base.video_generate",
      inputs: {
        model: { fromInput: "model", default: "ltx_2_3_fast" },
        prompt: { fromNode: "vision_motion_prompt", output: "text" },
        start_image_url: { fromNode: "upscale_product", output: "image_url" },
        duration: { fromInput: "duration", default: 8 },
        aspect_ratio: { fromInput: "aspect_ratio", default: "16:9" },
      },
    },
    {
      id: "upscale_video_4k",
      type: "base.video_upscale",
      inputs: {
        video_url: { fromNode: "generate_product_video", output: "video_url" },
        target_resolution: "4k",
      },
    },
    {
      id: "save_media",
      type: "base.save_media",
      inputs: {
        media_id: { fromInput: "media_id" },
        asset_url: { fromNode: "upscale_video_4k", output: "video_url" },
        final_prompt: { fromNode: "vision_motion_prompt", output: "text" },
        metadata: { fromNode: "upscale_video_4k", output: "metadata" },
      },
    },
  ],
});

export default productVideo4kV3;
