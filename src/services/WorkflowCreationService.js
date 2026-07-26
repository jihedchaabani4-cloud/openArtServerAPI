import { supabase } from "../../lib/supabase.js";

export class WorkflowCreationService {
  constructor({ db }) {
    this.db = db;
  }

  async createGenerationConfig(config = null) {
    if (!config) return null;

    const configRecord = await this.db.configs.createConfig({
      prompt: config.prompt || "",
      model: config.model || "unknown",
      aspect_ratio: config.aspect_ratio || "SQUARE",
      generation_type: config.generation_type || "TEXT_ONLY",
      seed: config.seed || null,
    });

    return configRecord.id;
  }

  async createWorkflowWithMedia({
    workflowData,
    mediaData,
    setAsPrimary = true,
    initialStatus = null,
  }) {
    const workflow = await this.db.workflows.createWorkflow(workflowData);
    const media = await this.db.media.createMedia({
      ...mediaData,
      ...(initialStatus ? { status: initialStatus } : {}),
      workflow_id: workflow.id,
    });

    if (setAsPrimary) {
      await this.db.workflows.updatePrimaryMedia(workflow.id, media.id);
    }

    return { workflow, media };
  }

  async createWorkflowWithMediaAtomic({ workflowData, mediaData }) {
    try {
      const { data, error } = await supabase.rpc(
        "create_workflow_with_placeholder_media",
        {
          p_project_id: workflowData.project_id || null,
          p_session_id: workflowData.session_id || null,
          p_display_name: workflowData.display_name || "Untitled",
          p_workflow_type: workflowData.workflow_type || "GENERATION",
          p_generation_config_id: mediaData.generation_config_id || null,
          p_step_id: mediaData.step_id || "GEN",
        }
      );

      if (error) {
        if (
          error.code === "PGRST202" ||
          error.code === "42883" ||
          (error.message &&
            error.message.includes("create_workflow_with_placeholder_media"))
        ) {
          console.warn(
            "[WorkflowCreationService] RPC not found — falling back to sequential inserts."
          );
          return this.createWorkflowWithMedia({
            workflowData,
            mediaData,
            setAsPrimary: true,
            initialStatus: mediaData.status || "processing",
          });
        }
        throw error;
      }

      return {
        workflow: { id: data.workflow_id },
        media: { id: data.media_id },
      };
    } catch (error) {
      console.warn(
        "[WorkflowCreationService] RPC error — falling back to sequential inserts:",
        error.message
      );
      return this.createWorkflowWithMedia({
        workflowData,
        mediaData,
        setAsPrimary: true,
        initialStatus: mediaData.status || "processing",
      });
    }
  }

  async appendMediaToWorkflow({
    workflow_id,
    workflowId,
    mediaData,
    setAsPrimary = true,
    initialStatus = null,
  }) {
    const resolvedWorkflowId = workflowId || workflow_id;
    const media = await this.db.media.createMedia({
      ...mediaData,
      ...(initialStatus ? { status: initialStatus } : {}),
      workflow_id: resolvedWorkflowId,
    });

    if (setAsPrimary) {
      await this.db.workflows.updatePrimaryMedia(resolvedWorkflowId, media.id);
    }

    return media;
  }

  async createPlaceholderWorkflow({
    projectId,
    sessionId = null,
    displayName,
    workflowType = "GENERATION",
    stepId = "GEN",
    config = null,
    mediaDefaults = {},
  }) {
    const generationConfigId = await this.createGenerationConfig(config);

    return this.createWorkflowWithMediaAtomic({
      workflowData: {
        project_id: projectId,
        session_id: sessionId,
        display_name: displayName,
        workflow_type: workflowType,
      },
      mediaData: {
        project_id: projectId,
        generation_config_id: generationConfigId,
        step_id: stepId,
        url: null,
        width: mediaDefaults.width || 1024,
        height: mediaDefaults.height || 1024,
        status: mediaDefaults.status || "processing",
      },
    });
  }

  async appendPlaceholderMedia({
    workflowId,
    projectId,
    stepId = "EDIT",
    config = null,
    mediaDefaults = {},
  }) {
    const generationConfigId = await this.createGenerationConfig(config);

    return this.appendMediaToWorkflow({
      workflowId,
      mediaData: {
        project_id: projectId,
        generation_config_id: generationConfigId,
        step_id: stepId,
        url: null,
        width: mediaDefaults.width || 1024,
        height: mediaDefaults.height || 1024,
        status: mediaDefaults.status || "processing",
      },
      setAsPrimary: true,
      initialStatus: mediaDefaults.status || "processing",
    });
  }
}

export async function createWorkflowWithMedia(db, params) {
  return new WorkflowCreationService({ db }).createWorkflowWithMedia(params);
}

export async function createWorkflowWithMediaAtomic(db, params) {
  return new WorkflowCreationService({ db }).createWorkflowWithMediaAtomic(params);
}

export async function appendMediaToWorkflow(db, params) {
  return new WorkflowCreationService({ db }).appendMediaToWorkflow(params);
}

export default WorkflowCreationService;
