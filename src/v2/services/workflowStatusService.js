import { RunRepository } from "../runner/runRepository.js";

export class WorkflowStatusService {
  constructor({ db }) {
    this.db = db;
    this.runRepo = new RunRepository();
  }

  async getStatus(executionId) {
    const run = await this.runRepo.getRun(executionId);
    if (!run) {
      return {
        error: {
          errorCode: "WORKFLOW_NOT_FOUND",
          message: "Workflow execution was not found.",
        },
      };
    }

    // Determine the placeholders/media assets linked to this V2 run.
    const placeholders = run.input?._v1PlaceholderIds || [];
    
    // Fetch the actual media assets from the database
    const mediaAssets = [];
    for (const ph of placeholders) {
      const mediaId = ph.mediaId || ph.id;
      if (mediaId) {
        try {
          const media = await this.db.media.findById(mediaId);
          if (media) {
            mediaAssets.push({
              id: media.id,
              url: media.url,
              type: media.step_id === "VID" ? "video" : "image",
              width: media.width,
              height: media.height,
              status: media.status,
              error_message: media.error_message,
            });
          }
        } catch (err) {
          console.warn(`[WorkflowStatusService] Failed to load media ${mediaId}:`, err.message);
        }
      }
    }

    return {
      executionId: run.run_id,
      workflowId: run.workflow_id,
      status: run.status,
      jobReference: run.run_id,
      mediaAssets,
      error: run.error || null,
      traceId: run.run_id,
    };
  }
}
