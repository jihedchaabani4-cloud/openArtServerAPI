import { createWorkflowWithMedia, createWorkflowWithMediaAtomic, appendMediaToWorkflow } from "../../db/workflowMediaOps.js";

/**
 * V2 → V1 Storage Bridge
 *
 * Ce service crée des entrées V1 (workflow + media) depuis les outputs V2.
 * Permet de réutiliser le système de stockage V1 éprouvé dans le moteur V2.
 *
 * Lifecycle:
 *   Phase 1 – createV1Placeholder : crée workflow + media avec status='processing', url=null
 *   Phase 2 – finalizeV1Media     : met à jour le media avec l'URL finale et status='success'/'failed'
 */

export class V1StorageBridge {
  constructor({ db }) {
    this.db = db;
  }

  // ─────────────────────────────────────────────────────
  // Phase 1 — Placeholder creation (before provider call)
  // ─────────────────────────────────────────────────────

  /**
   * Creates a V1 workflow + media placeholder (status='processing', url=null).
   * Used before the provider generates the actual asset.
   *
   * @param {Object} params
   * @param {string} params.userId
   * @param {string} params.projectId
   * @param {string|null} params.sessionId
   * @param {string} params.displayName
   * @param {string} params.workflowType  — 'GENERATION' | 'ELEMENT_SHEET'
   * @param {string} params.stepId        — 'GEN' | 'EDIT' | 'VID' | 'UPSCALE'
   * @param {Object|null} params.config   — generation config for generation_config table
   * @returns {{ workflow: Object, media: Object }}
   */
  async createV1Placeholder(params) {
    const {
      userId,
      projectId,
      sessionId = null,
      displayName,
      workflowType = "GENERATION",
      stepId = "GEN",
      config = null,
    } = params;

    if (!projectId) {
      console.warn("[V1StorageBridge] Placeholder creation aborted: projectId is missing.");
      return { workflow: null, media: null };
    }

    const validWfType = workflowType;

    const workflowData = {
      project_id: projectId,
      session_id: sessionId,
      display_name: displayName,
      workflow_type: validWfType,
    };

    let generationConfigId = null;
    if (config) {
      const configRecord = await this.db.configs.createConfig({
        prompt: config.prompt || "",
        model: config.model || "unknown",
        aspect_ratio: config.aspect_ratio || "SQUARE",
        generation_type: config.generation_type || "TEXT_ONLY",
        seed: config.seed || null,
      });
      generationConfigId = configRecord.id;
    }

    // Create media with null url and status='processing'
    const mediaData = {
      project_id: projectId,
      generation_config_id: generationConfigId,
      step_id: stepId,
      url: null,
      width: 1024,
      height: 1024,
      status: "processing",
    };

    const { workflow, media } = await createWorkflowWithMediaAtomic(this.db, {
      workflowData,
      mediaData,
    });

    // Auto-create row in public.characters table ONLY for character workflows
    if (workflowType === "CHARACTER") {
      try {
        const charName = displayName || config?.prompt?.slice(0, 50) || "Untitled Character";
        await this.db.projects.client().from("characters").insert({
          user_id: userId,
          project_id: projectId,
          workflow_id: workflow.id,
          name: charName,
          title: charName,
          description: config?.prompt || "",
          character_info: config?.prompt || "",
          status: "ready",
        });
        console.log(`[V1StorageBridge] Created 'public.characters' row for workflow=${workflow.id}`);
      } catch (charErr) {
        console.warn(`[V1StorageBridge] Notice creating 'public.characters' row:`, charErr.message);
      }
    }

    console.log(
      `[V1StorageBridge] Placeholder created: workflow=${workflow.id} media=${media.id} (processing)`
    );
    return { workflow, media };
  }

  /**
   * Creates a V1 media placeholder appended to an existing workflow.
   * Used for edit/transform operations where a workflow already exists.
   *
   * @param {Object} params
   * @param {string} params.workflowId
   * @param {string} params.projectId
   * @param {string} params.stepId   — 'EDIT' | 'VID' | 'UPSCALE'
   * @param {Object|null} params.config
   * @returns {Object} media record
   */
  async appendV1Placeholder(params) {
    const {
      workflowId,
      projectId,
      stepId = "EDIT",
      config = null,
    } = params;

    let generationConfigId = null;
    if (config) {
      const configRecord = await this.db.configs.createConfig({
        prompt: config.prompt || "",
        model: config.model || "unknown",
        aspect_ratio: config.aspect_ratio || "SQUARE",
        generation_type: config.generation_type || "IMAGE_TO_IMAGE",
      });
      generationConfigId = configRecord.id;
    }

    const mediaData = {
      project_id: projectId,
      generation_config_id: generationConfigId,
      step_id: stepId,
      url: null,
      width: 1024,
      height: 1024,
      status: "processing",
    };

    const media = await appendMediaToWorkflow(this.db, {
      workflow_id: workflowId,
      mediaData,
      setAsPrimary: true,
      initialStatus: "processing",
    });

    console.log(
      `[V1StorageBridge] Placeholder appended: workflow=${workflowId} media=${media.id} (processing)`
    );
    return media;
  }

  // ─────────────────────────────────────────────────────
  // Phase 2 — Finalization (after provider call)
  // ─────────────────────────────────────────────────────

  /**
   * Finalizes a media placeholder with the actual URL and final status.
   * Call this after the provider returns successfully.
   *
   * @param {string} mediaId
   * @param {Object} asset — { url, width?, height? }
   * @param {string} [status='success']
   */
  async finalizeV1Media(mediaId, asset, status = "success") {
    await this.db.media.updateFields(mediaId, {
      url: asset.url,
      width: asset.width || 1024,
      height: asset.height || 1024,
      status,
      error_message: null,
    });

    console.log(
      `[V1StorageBridge] Finalized media=${mediaId} → status=${status} url=${asset.url}`
    );
  }

  /**
   * Marks a media placeholder as failed.
   *
   * @param {string} mediaId
   * @param {string|Error} error
   */
  async failV1Media(mediaId, error) {
    const message =
      typeof error === "string"
        ? error
        : error?.message || "Generation failed";

    await this.db.media.updateFields(mediaId, {
      status: "failed",
      error_message: message,
    });

    console.warn(`[V1StorageBridge] Failed media=${mediaId}: ${message}`);
  }

  // ─────────────────────────────────────────────────────
  // Legacy — single-phase persistence (kept for reference)
  // ─────────────────────────────────────────────────────

  /**
   * Creates a new V1 workflow + media from a V2 output.
   * @deprecated Use createV1Placeholder + finalizeV1Media instead.
   */
  async createV1Workflow(params) {
    const {
      userId,
      projectId,
      sessionId = null,
      displayName,
      workflowType = "GENERATION",
      asset,
      config,
      stepId = "GEN",
    } = params;

    const workflowData = {
      project_id: projectId,
      session_id: sessionId,
      display_name: displayName,
      workflow_type: workflowType,
    };

    let generationConfigId = null;
    if (config) {
      const configRecord = await this.db.configs.createConfig({
        prompt: config.prompt || "",
        model: config.model || "unknown",
        aspect_ratio: config.aspect_ratio || "SQUARE",
        generation_type: config.generation_type || "TEXT_ONLY",
        seed: config.seed || null,
      });
      generationConfigId = configRecord.id;
    }

    const mediaData = {
      project_id: projectId,
      generation_config_id: generationConfigId,
      step_id: stepId,
      url: asset.url,
      width: asset.width || 1024,
      height: asset.height || 1024,
      status: "success",
    };

    const { workflow, media } = await createWorkflowWithMedia(this.db, {
      workflowData,
      mediaData,
      setAsPrimary: true,
    });

    if (workflowType === "CHARACTER") {
      try {
        const charName = displayName || config?.prompt?.slice(0, 50) || "Untitled Character";
        await this.db.projects.client().from("characters").insert({
          user_id: userId,
          project_id: projectId,
          workflow_id: workflow.id,
          name: charName,
          title: charName,
          description: config?.prompt || "",
          character_info: config?.prompt || "",
          status: "ready",
        });
        console.log(`[V1StorageBridge] Created 'public.characters' row for workflow=${workflow.id}`);
      } catch (charErr) {
        console.warn(`[V1StorageBridge] Notice creating 'public.characters' row:`, charErr.message);
      }
    }

    return { workflow, media };
  }

  /**
   * Appends a new media to an existing V1 workflow.
   * @deprecated Use appendV1Placeholder + finalizeV1Media instead.
   */
  async appendToV1Workflow(params) {
    const {
      workflowId,
      projectId,
      asset,
      config,
      stepId = "EDIT",
      setAsPrimary = true,
    } = params;

    let generationConfigId = null;
    if (config) {
      const configRecord = await this.db.configs.createConfig({
        prompt: config.prompt || "",
        model: config.model || "unknown",
        aspect_ratio: config.aspect_ratio || "SQUARE",
        generation_type: config.generation_type || "TEXT_ONLY",
      });
      generationConfigId = configRecord.id;
    }

    const mediaData = {
      project_id: projectId,
      generation_config_id: generationConfigId,
      step_id: stepId,
      url: asset.url,
      width: asset.width || 1024,
      height: asset.height || 1024,
      status: "success",
    };

    const media = await appendMediaToWorkflow(this.db, {
      workflow_id: workflowId,
      mediaData,
      setAsPrimary,
    });

    return media;
  }

  // ─────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────

  /**
   * Extracts a single asset object from a V2 node output.
   */
  extractAsset(output, nodeType) {
    if (!output) return null;
    if (nodeType === "image-generation") return output.assets?.[0] || null;
    if (nodeType === "media-transform") return output.asset || null;
    if (nodeType === "video-generation") return output.asset || null;
    if (nodeType === "upscale") return output.enhancedAsset || null;
    return null;
  }

  /**
   * Infers an aspect-ratio string from pixel dimensions.
   */
  getAspectRatio(width, height) {
    if (!width || !height) return "SQUARE";
    const ratio = width / height;
    if (ratio > 1.3) return "LANDSCAPE";
    if (ratio < 0.8) return "PORTRAIT";
    return "SQUARE";
  }

  /**
   * Returns an existing "V2 Works" project for the user, or creates one.
   * Uses db.projects repository for correct Supabase RLS access.
   */
  async getOrCreateDefaultProject(userId) {
    try {
      const { data, error } = await this.db.projects
        .client()
        .from("project")
        .select("id")
        .eq("user_id", userId)
        .ilike("project_name", "V2 Works")
        .maybeSingle();

      if (!error && data?.id) return data.id;

      const { data: newProject, error: createErr } = await this.db.projects
        .client()
        .from("project")
        .insert({ project_name: "V2 Works", user_id: userId })
        .select()
        .single();

      if (createErr) {
        console.error("[V1StorageBridge] Failed to create default project:", createErr);
        return "00000000-0000-0000-0000-000000000001";
      }
      return newProject.id;
    } catch (err) {
      console.error("[V1StorageBridge] getOrCreateDefaultProject error:", err);
      return "00000000-0000-0000-0000-000000000001";
    }
  }
}

export default V1StorageBridge;
