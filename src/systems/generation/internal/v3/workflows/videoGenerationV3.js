/**
 * VideoGenerationV3 Workflow Blueprint (`video-generation-v3`)
 *
 * ComfyUI-Style Linear 4-Node DAG:
 *   1) [resolve_refs]   (`base.resolve_references`)
 *   2) [llm_process]    (`base.llm` with skills: ["system-safety", "translate"])
 *   3) [generate_video] (`base.video_generate`)
 *   4) [save_media]     (`base.save_media`)
 */
export const videoGenerationV3 = Object.freeze({
  id: "video-generation-v3",
  name: "Video Generation V3",
  version: "3.0.0",
  category: "video",
  description:
    "Declarative 4-node V3 video generation pipeline: reference & tag resolution, single-call LLM safety check + translation, video generation, and explicit media persistence.",

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
      id: "generate_video",
      type: "base.video_generate",
      inputs: {
        model: { fromInput: "model", default: "ltx_2_3_fast" },
        prompt: { fromNode: "llm_process", output: "final_prompt" },
        start_image_url: { fromInput: "start_image_url" },
        end_image_url: { fromInput: "end_image_url" },
        input_video_url: { fromInput: "input_video_url" },
        duration: { fromInput: "duration", default: 8 },
        aspect_ratio: { fromInput: "aspect_ratio", default: "16:9" },
        parameters: { fromInput: "parameters", default: {} },
      },
    },
    {
      id: "save_media",
      type: "base.save_media",
      inputs: {
        media_id: { fromInput: "media_id" },
        asset_url: { fromNode: "generate_video", output: "video_url" },
        final_prompt: { fromNode: "llm_process", output: "final_prompt" },
        metadata: { fromNode: "generate_video", output: "metadata" },
      },
    },
  ],
});

export default videoGenerationV3;
