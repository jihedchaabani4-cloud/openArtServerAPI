/**
 * VideoGenerationV3 Workflow Blueprint (`video-generation-v3`)
 *
 * ComfyUI-Style DAG:
 *   [safety_check] ──┐
 *                    ├──> [llm_translate] ──> [prompt_assemble] ──> [video_generate] ──> [save_media]
 *   [resolve_refs] ──┘
 */
export const videoGenerationV3 = Object.freeze({
  id: "video-generation-v3",
  name: "Video Generation V3",
  version: "3.0.0",
  category: "video",
  description:
    "Declarative V3 video generation pipeline with fail-closed safety check, parallel reference resolution, LLM translation, prompt assembly, video generation, and explicit media persistence.",

  nodes: [
    {
      id: "safety_check",
      type: "base.safety_check",
      inputs: {
        prompt: { fromInput: "prompt" },
      },
    },
    {
      id: "resolve_refs",
      type: "base.resolve_references",
      inputs: {
        references: { fromInput: "references", default: [] },
        characters: { fromInput: "characters", default: [] },
        elements: { fromInput: "elements", default: [] },
      },
    },
    {
      id: "llm_translate",
      type: "base.llm_text",
      inputs: {
        prompt: { fromNode: "safety_check", output: "safe_prompt" },
        system_instruction:
          "Translate the user prompt into clear, faithful cinematic English for video generation.",
        json_mode: false,
      },
    },
    {
      id: "prompt_assemble",
      type: "base.prompt_assemble",
      inputs: {
        prompt: { fromNode: "llm_translate", output: "text" },
        entities: { fromNode: "resolve_refs", output: "entities" },
        style: { fromInput: "style", default: "" },
      },
    },
    {
      id: "generate_video",
      type: "base.video_generate",
      inputs: {
        model: { fromInput: "model", default: "ltx_2_3_fast" },
        prompt: { fromNode: "prompt_assemble", output: "final_prompt" },
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
        final_prompt: { fromNode: "prompt_assemble", output: "final_prompt" },
        metadata: { fromNode: "generate_video", output: "metadata" },
      },
    },
  ],
});

export default videoGenerationV3;
