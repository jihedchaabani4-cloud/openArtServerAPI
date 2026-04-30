import { BaseEditTreatment } from "../basetretment/BaseEditTreatment.js";
import { resolveReferences }  from "../../utils/resolveReferences.js";

export class EditImageTreatment extends BaseEditTreatment {

  // ─────────────────────────────────────────────────────────────────────────
  // prepare — params explicites propres à l'edit standard
  // ─────────────────────────────────────────────────────────────────────────

  async prepare({
    prompt,
    model_name      = "nanobana",
    ratio,
    quality,
    seed,
    steps,
    guidance_scale,
    negative_prompt,
    reference_workflow_ids = [],
    userId,
    project_id,
    session_id,
    workflow_id,
  }) {
    if (!userId)      throw new Error("userId required");
    if (!project_id)  throw new Error("project_id required");
    if (!workflow_id) throw new Error("workflow_id required");

    // ── Build references from workflows ────────────────────────────────────
    const references = await resolveReferences(this.db, {
      baseWorkflowId:       workflow_id,
      referenceWorkflowIds: reference_workflow_ids,
    });

    // ── Delegate shared logic to base ──────────────────────────────────────
    return this._runPrepare({
      prompt,
      references,
      model_name,
      ratio,
      quality,
      seed,
      steps,
      guidance_scale,
      negative_prompt,
      userId,
      project_id,
      session_id,
      workflow_id,
      stepId: "EDIT",
    });
  }
}
