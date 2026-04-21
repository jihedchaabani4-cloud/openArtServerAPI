import { BaseEditTreatment } from "../basetretment/BaseEditTreatment.js";

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
    if (!session_id)  throw new Error("session_id required");
    if (!workflow_id) throw new Error("workflow_id required");

    // ── Build references from workflows ────────────────────────────────────
    const rawRefs = [];
    for (const refWfId of (reference_workflow_ids || [])) {
      const pm = await this.db.workflows.getPrimaryMedia(refWfId);
      if (pm?.url && !rawRefs.find(r => r.url === pm.url)) {
        rawRefs.push({ url: pm.url, role: "reference", is_base: false });
      }
    }

    // Auto-resolve primary media from workflow
    const primaryMedia = await this.db.workflows.getPrimaryMedia(workflow_id);
    if (primaryMedia?.url && !rawRefs.find(r => r.url === primaryMedia.url)) {
      rawRefs.unshift({ url: primaryMedia.url, role: "source", is_base: true });
    }
    // ── Delegate shared logic to base ──────────────────────────────────────
    return this._runPrepare({
      prompt,
      references: rawRefs,
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