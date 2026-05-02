import { BaseGenerateImageTreatment } from "../basetretment/BaseGenerateImageTreatment.js";
import { processPrompt }             from "../../../services/promptServiceV2.js";
import { markMediaFailed }            from "#db/workflowMediaOps.js";
import { resolveReferences }          from "../../utils/resolveReferences.js";

/**
 * GenerateImageTreatment
 *
 * Handles standard text-to-image and reference-based generation.
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
      references      = [],
    } = input;

    const userId = input.userId || input.user_id;
    if (!userId)     throw new Error("userId required");
    if (!project_id) throw new Error("project_id required");

    let { ratio, quality, steps, guidance_scale, count = 1 } = input;

    // ── Resolve reference media IDs → Enriched Assets ───────────────────
    const referenceMediaIds = references
      .map(ref => ref.media_id || ref.id)
      .filter(Boolean);

    const input_assets = await resolveReferences(this.db, {
      referenceMediaIds
    });

    // Handle direct URLs if any (rare in current flow but good for compatibility)
    for (const ref of references) {
      if (ref.url && !input_assets.find(a => a.url === ref.url)) {
        input_assets.push({
          url:     ref.url,
          role:    ref.role    || "reference",
          media_id: ref.media_id || ref.asset_id || ref.id || null,
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
      extraTaskFields: {
        rawReferences: input_assets // for optimizePrompt tags
      }
    });
  }

  /**
   * optimizePrompt — overrides base to use promptServiceV2
   */
  async optimizePrompt(task) {
    const { prompt, prompt_optimise, negative_prompt, mediaIds, model_name, rawReferences = [] } = task;
    const rawPrompt = prompt_optimise || prompt;

    let finalNegative = negative_prompt || "";

    if (!rawPrompt) return { finalPrompt: prompt, finalNegative };

    // ── 1. Use the new single-call pipeline ──────────────────────────────
    const result = await processPrompt({
      prompt:     rawPrompt,
      references: rawReferences,
      modelType:  model_name?.includes("runway") ? "runway" : "kling", // simple mapping for now
      textProvider: this.promptService.textProvider,
    });

    if (!result.success) {
      this._log("error", `prompt optimization failed: ${result.reason}`);
    } else {
      // ── Save optimized prompt back to DB ────────────────────────────────
      if (task.configId) {
        await this.db.configs.updateFields(task.configId, { prompt_optimise: result.prompt })
          .catch(err => this._log("error", `Failed to save optimized prompt: ${err.message}`));
      }
    }

    const finalPrompt = result.success ? result.prompt : rawPrompt;

    // ── 2. Generate negative prompt (optional, fallback to old service) ──
    try {
      const autoNeg = await this.promptService.generateNegativePrompt(finalPrompt);
      finalNegative = [negative_prompt || "", autoNeg || ""].filter(Boolean).join(", ");
    } catch (e) {
      this._log("error", `Failed to generate negative prompt: ${e.message}`);
    }

    return { finalPrompt, finalNegative };
  }

  // run(), _runVariation(), execute() — all inherited from base ✅
}
