export const videoGenerationV3 = Object.freeze({
  id: "video-generation-v3",
  aliases: Object.freeze(["videoGeneration"]),
  name: "Video Generation V3",
  version: "3.0.0",
  category: "video",
  requiredInputs: Object.freeze(["prompt"]),
  description:
    "Declarative 4-node video generation pipeline: reference & tag resolution, single-call LLM safety check + translation + video prompt preparation, video generation, and explicit media persistence.",

  nodes: [
    {
      id: "resolve_refs",
      type: "base.resolve_references",
      inputs: {
        prompt: { fromInput: "prompt" },
        references: { fromInput: "references", default: [] },
        characters: { fromInput: "characters", default: [] },
        elements: { fromInput: "elements", default: [] },
        verify_ownership: { fromInput: "verify_ownership", default: true },
      },
    },
    {
      id: "llm_process",
      type: "base.llm",
      inputs: {
        prompt: { fromNode: "resolve_refs", output: "prepared_prompt" },
        skills: ["system-safety", "translate", "video-generation"],
        timeout_ms: 15000,
      },
    },
    {
      id: "generate_video",
      type: "base.video_generate",
      inputs: {
        model: { fromInput: "model", default: "ltx_2_3_fast" },
        prompt: { fromNode: "llm_process", output: "text" },
        start_image_url: { fromInput: "start_image_url" },
        end_image_url: { fromInput: "end_image_url" },
        input_video_url: { fromInput: "input_video_url" },
        parameters: { fromInput: "parameters", default: {} },
      },
    },
    {
      id: "save_media",
      type: "base.save_media",
      inputs: {
        media_id: { fromInput: "media_id" },
        asset_url: { fromNode: "generate_video", output: "video_url" },
        final_prompt: { fromNode: "llm_process", output: "text" },
        metadata: { fromNode: "generate_video", output: "metadata" },
        media_role: "output",
        save_type: "video_output",
      },
    },
  ],
});

export default videoGenerationV3;
