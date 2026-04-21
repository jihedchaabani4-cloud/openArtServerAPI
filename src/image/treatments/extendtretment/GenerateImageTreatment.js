import { BaseGenerateImageTreatment } from "../basetretment/BaseGenerateImageTreatment.js";

/**
 * GenerateImageTreatment
 *
 * Handles standard text-to-image and reference-based generation.
 * Extends BaseGenerateImageTreatment — only overrides prepare()
 * to resolve reference workflow IDs into URLs before delegating
 * all shared logic to _runPrepare().
 *
 * Usage (same as before):
 *   const result = await treatment.execute(input);
 *   // or
 *   const task = await treatment.prepare(input);
 *   await treatment.run(task);  // can be queued in Redis
 */
export class GenerateImageTreatment extends BaseGenerateImageTreatment {

  /**
   * prepare — resolve references then delegate to base _runPrepare()
   */
  async prepare(input) {
    const {
      prompt,
      prompt_optimise = null,
      display_name    = null,
      negative_prompt = "",
      model_name      = "nanobana",
      workflow_type   = "GENERATION",
      seed,
      strength,
      project_id,
      session_id,
    } = input;

    const userId = input.userId || input.user_id;
    if (!userId)     throw new Error("userId required");
    if (!project_id) throw new Error("project_id required");

    let { ratio, quality, steps, guidance_scale, count = 1, references = [] } = input;

    // ── Resolve reference workflow IDs → URLs ───────────────────────────
    const input_assets = [];
    for (const ref of references) {
      const wfId = ref.workflow_id || ref.id;
      if (!wfId) continue;

      const media = await this.db.media.findLatestByWorkflow(wfId);
      if (media?.url) {
        input_assets.push({
          url:     media.url,
          role:    ref.role    || "reference",
          is_base: ref.is_base || false,
        });
      }
    }

    // ── Delegate everything else to base ────────────────────────────────
    return this._runPrepare({
      prompt,
      prompt_optimise,
      display_name,
      negative_prompt,
      model_name,
      workflow_type,
      ratio,
      quality,
      steps,
      guidance_scale,
      count,
      seed,
      strength,
      userId,
      project_id,
      session_id,
      input_assets,
      stepId: "GEN",
    });
  }

  // run(), _runVariation(), execute() — all inherited from base ✅
}
