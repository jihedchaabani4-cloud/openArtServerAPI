import { supabase, supabaseAdmin } from "../../../lib/supabase.js";
import { getCatalog } from "../../models/index.js";
import { crudOperationLog, CrudServiceError } from "../../utils/crudOperationLog.js";
import { calculateAspectRatio } from "../../utils/ratioUtils.js";
import { createLogger } from "../../infrastructure/logging/index.js";

const projectLogger = createLogger("project_read");

function getCatalogPricing() {
    const catalog = getCatalog();
    const pricing = {};
    for (const m of catalog) {
        if (m.retailPricing) {
            pricing[m.modelFamily || m.id] = m.retailPricing;
        }
    }
    return pricing;
}

const APP_CONFIG = {
    changeLogId: "2026-03-19-v1-3f4e036c-6a67-467f-a0e6-25cff0a0a8ab",
    get pricing() {
        return getCatalogPricing();
    },
};

function normalizeMediaStatus(status, url) {
    return status || (url ? "success" : "processing");
}

export class ProjectReadService {
    constructor({ db }) {
        this.db = db;
    }

    async getProjectData({ projectId, userId }) {
        const started = Date.now();
        const operation = "getProjectData";

        if (!projectId || projectId === "null" || projectId === "undefined") {
            crudOperationLog({ operation, status: "ok", durationMs: Date.now() - started });
            return {
                projectName: "Unknown Project",
                projectId: null,
                sessions: [],
                workflows: [],
                media: [],
                elements: [],
            };
        }

        const { data: projectData, error: projectError } = await supabase
            .from("project")
            .select("project_name, user_id")
            .eq("id", projectId)
            .single();

        if (projectError || !projectData) {
            throw new CrudServiceError("Project not found", { statusCode: 404, errorCode: "PROJECT_NOT_FOUND" });
        }

        if (!projectData.user_id || projectData.user_id !== userId) {
            const isDev = (process.env.DEV_AUTH_BYPASS === "true" || process.env.DEV_AUTH_BYPASS === true) && process.env.NODE_ENV !== "production";
            if (!isDev) {
                crudOperationLog({
                    operation: "getProjectData",
                    status: "error",
                    userId,
                    resourceId: projectId,
                    resourceType: "project",
                    errorCode: "NOT_FOUND",
                    message: "Project not found",
                });
                throw new CrudServiceError("Project not found", {
                    statusCode: 404,
                    errorCode: "NOT_FOUND",
                });
            }
        }

        const projectName = projectData?.project_name || "Unknown Project";

        // Fetch workflows and media concurrently to minimize latency
        const [workflowsResult, mediaResult] = await Promise.all([
            this.db.workflows
                .findByProject(projectId, {
                    select: "id, display_name, variation_index, primary_media_id, create_time, session_id, favorited, workflow_type, folder_id",
                    order: { column: "create_time", ascending: false },
                })
                .catch((err) => {
                    projectLogger.error({ event: "project_read.workflow_query_error", err: err?.message || String(err) }, "Workflow query error");
                    return [];
                }),
            supabase
                .from("media")
                .select(`
                    id, step_id, url, width, height, create_time, status, error_message,
                    workflow_id, generation_config_id,
                    generation_config (
                        id, prompt, model, aspect_ratio, generation_type, seed, visibility,
                        dna:dna ( id, name, type, description, traits ),
                        references:generation_config_reference!generation_config_reference_generation_config_id_fkey (
                            id, position, input_type, ref_media_id,
                            ref_media:media ( id, url, width, height )
                        )
                    )
                `)
                .eq("project_id", projectId)
                .order("create_time", { ascending: false }),
        ]);

        const workflows = workflowsResult || [];
        const mediaItems = mediaResult.data || [];
        if (mediaResult.error) projectLogger.error({ event: "project_read.media_query_error", err: mediaResult.error.message }, "Media query error");

        const formattedSessions = [];

        const workflowIds = (workflows || []).map((w) => w.id);
        let elementMap = {};
        let characterMap = {};
        let elementsList = [];
        let charactersList = [];

        if (workflowIds.length > 0) {
            const [elemResult, charResult] = await Promise.all([
                supabase
                    .from("element")
                    .select("*")
                    .in("workflow_id", workflowIds),
                supabaseAdmin
                    .from("characters")
                    .select("*")
                    .or(`project_id.eq.${projectId},workflow_id.in.(${workflowIds.join(",")})`),
            ]);

            if (elemResult.error) {
                projectLogger.warn({ event: "project_read.element_query_warn", err: elemResult.error.message }, "Element query warning");
            } else if (elemResult.data) {
                elementsList = elemResult.data;
                elementsList.forEach((elem) => {
                    elementMap[elem.workflow_id] = elem;
                });
            }

            if (charResult.error) {
                projectLogger.warn({ event: "project_read.character_query_warn", err: charResult.error.message }, "Characters query warning");
            } else if (charResult.data) {
                charactersList = charResult.data;
                charactersList.forEach((c) => {
                    if (c.workflow_id) characterMap[c.workflow_id] = c;
                    if (c.id) characterMap[c.id] = c;
                });
            }
        } else {
            // Also fetch characters directly by project_id when no workflows exist yet
            const { data: chars, error: charErr } = await supabaseAdmin
                .from("characters")
                .select("*")
                .eq("project_id", projectId);

            if (!charErr && chars) {
                charactersList = chars;
                charactersList.forEach((c) => {
                    if (c.workflow_id) characterMap[c.workflow_id] = c;
                    if (c.id) characterMap[c.id] = c;
                });
            }
        }

        const formattedWorkflows = (workflows || []).map((wf) => {
            const elem = elementMap[wf.id] || {};
            const char = characterMap[wf.id] || {};
            const displayName = char.name || char.title || elem.name || wf.display_name || "Untitled Workflow";

            return {
                id: wf.id,
                name: wf.id,
                display_name: displayName,
                projectId,
                workflow_type: wf.workflow_type,
                folder_id: wf.folder_id || null,
                folderId: wf.folder_id || null,
                primary_media_id: wf.primary_media_id || "",
                primaryMediaId: wf.primary_media_id || "",
                metadata: {
                    displayName,
                    createTime: wf.create_time,
                    primaryMediaId: wf.primary_media_id || "",
                    sessionId: wf.session_id,
                    favorited: !!wf.favorited,
                    folder_id: wf.folder_id || null,
                    folderId: wf.folder_id || null,
                },
            };
        });

        const workflowMap = new Map((workflows || []).map((w) => [w.id, w]));
        const workflowMediaRelationByMediaId = new Map();

        if (workflowIds.length > 0) {
            const { data: relationRows, error: relationErr } = await supabase
                .from("workflow_media")
                .select("workflow_id, media_id, role, created_at")
                .in("workflow_id", workflowIds);

            if (relationErr) {
                projectLogger.warn(
                    { event: "project_read.workflow_media_query_warn", err: relationErr.message },
                    "Workflow media relation query warning"
                );
            } else {
                for (const row of relationRows || []) {
                    if (row?.media_id) workflowMediaRelationByMediaId.set(row.media_id, row);
                }
            }
        }

        const formattedMedia = (mediaItems || []).map((m) => {
            const config = m.generation_config;
            const refs = (config?.references || []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
            const isVideo = m.url && /\.(mp4|webm|mov)$/i.test(m.url);
            const relation = workflowMediaRelationByMediaId.get(m.id);
            const mediaWorkflowId = relation?.workflow_id || m.workflow_id;
            const mediaRole = relation?.role || null;
            const wf = workflowMap.get(mediaWorkflowId);
            const isUpload = !m.generation_config_id ||
                             wf?.workflow_type === "UPLOAD" ||
                             mediaRole === "original" ||
                             config?.generation_type === "UPLOAD" ||
                             m.step_id === "CAE" ||
                             m.step_id === "upload";

            const imageGenerationImageInputs = isUpload
                ? undefined
                : refs.map((ref) => ({
                      imageInputType: ref.input_type || "IMAGE_INPUT_TYPE_BASE_IMAGE",
                      mediaId: ref.ref_media_id,
                  }));

            const promptParts = [];
            if (config?.prompt) promptParts.push({ text: config.prompt });
            refs.forEach((ref) => {
                if (ref.ref_media?.url) {
                    promptParts.push({
                        reference: {
                            media: {
                                mediaId: ref.ref_media_id,
                                url: ref.ref_media.url,
                            },
                        },
                    });
                }
            });

            const mediaObject = {
                name: m.id,
                id: m.id,
                url: m.url,
                file_url: m.url,
                status: normalizeMediaStatus(m.status, m.url),
                error: m.error_message || null,
                projectId,
                workflowId: mediaWorkflowId,
                workflow_id: mediaWorkflowId,
                folder_id: wf?.folder_id || null,
                folderId: wf?.folder_id || null,
                role: mediaRole,
                mediaRole,
                step_id: m.step_id,
                workflowStepId: m.step_id || (isUpload ? "upload" : "GEN"),
                create_time: m.create_time,
                createTime: m.create_time,
                generationConfig: config
                    ? {
                          prompt: config.prompt || "",
                          model: config.model || "",
                          aspectRatio: config.aspect_ratio || "",
                          generationType: config.generation_type || "",
                          seed: config.seed ?? null,
                          references: refs.map((ref) => ({
                              url: ref.ref_media?.url || "",
                              asset_id: ref.ref_media_id,
                              role: ref.input_type || "IMAGE_INPUT_TYPE_BASE_IMAGE",
                          })),
                          dna: config.dna && config.dna.length > 0 ? config.dna[0] : null,
                      }
                    : null,
                mediaMetadata: {
                    createTime: m.create_time,
                    requestData: {
                        promptInputs: config?.prompt
                            ? [{ textInput: config.prompt, structuredPrompt: { parts: promptParts } }]
                            : [],
                        clientPlatform: "CLIENT_PLATFORM_WEB",
                        imageGenerationRequestData: isUpload ? undefined : {},
                        imageGenerationImageInputs,
                    },
                    visibility: config?.visibility || "PRIVATE",
                },
            };

            const resolvedWidth = m.width || (isVideo ? 1280 : 1024);
            const resolvedHeight = m.height || (isVideo ? 720 : 1024);
            const resolvedRatio = (m.width && m.height)
                ? calculateAspectRatio(m.width, m.height)
                : (config?.aspect_ratio || (isVideo ? "16:9" : "1:1"));

            if (isVideo) {
                mediaObject.video = {
                    generatedVideo: config
                        ? {
                              seed: config.seed ?? null,
                              model: config.model || "",
                              prompt: config.prompt || "",
                              aspectRatio: config.aspect_ratio || resolvedRatio,
                              url: m.url,
                          }
                        : null,
                    dimensions: { width: resolvedWidth, height: resolvedHeight },
                };
            } else {
                mediaObject.image = {
                    generatedImage:
                        !isUpload && config
                            ? {
                                  seed: config.seed ?? null,
                                  prompt: config.prompt || "",
                                  modelNameType: config.model || "",
                                  workflowId: mediaWorkflowId,
                                  aspectRatio: config.aspect_ratio || resolvedRatio,
                                  url: m.url,
                              }
                            : null,
                    userUploadedImage: isUpload ? { aspectRatio: resolvedRatio } : undefined,
                    dimensions: { width: resolvedWidth, height: resolvedHeight },
                };
            }

            mediaObject.width = resolvedWidth;
            mediaObject.height = resolvedHeight;
            mediaObject.aspectRatio = resolvedRatio;
            mediaObject.ratio = resolvedRatio;
            mediaObject.dimensions = { width: resolvedWidth, height: resolvedHeight };
            mediaObject.params = {
                ratio: resolvedRatio,
                aspectRatio: resolvedRatio,
                width: resolvedWidth,
                height: resolvedHeight,
            };

            return mediaObject;
        });

        crudOperationLog({
            operation,
            status: "ok",
            durationMs: Date.now() - started,
            projectId,
            workflowCount: formattedWorkflows.length,
            mediaCount: formattedMedia.length,
        });

        return {
            projectName,
            projectId,
            sessions: formattedSessions,
            workflows: formattedWorkflows,
            media: formattedMedia,
            elements: elementsList,
            characters: charactersList,
        };
    }

    async getWorkflowByMedia({ mediaId, userId, req = null }) {
        const started = Date.now();
        const operation = "getWorkflowByMedia";

        if (!mediaId) {
            throw new CrudServiceError("media_id is required", { statusCode: 400, errorCode: "VALIDATION_ERROR" });
        }

        const isAuthorized = await this._verifyMediaOwnership(mediaId, userId, req);
        if (!isAuthorized) {
            throw new CrudServiceError("Media not found", {
                statusCode: 404,
                errorCode: "NOT_FOUND",
            });
        }

        const { data: media, error: mediaErr } = await supabase
            .from("media")
            .select("id, workflow_id, project_id, status, url, create_time, error_message")
            .eq("id", mediaId)
            .single();

        if (mediaErr) throw mediaErr;

        const workflowId = media.workflow_id;
        const workflow = await this.db.workflows.getWorkflow(workflowId);
        const items = await this.db.media.findByWorkflow(workflowId);

        crudOperationLog({ operation, status: "ok", durationMs: Date.now() - started, mediaId, workflowId });

        return { workflow, items };
    }

    async _verifyMediaOwnership(mediaId, userId, req = null) {
        const isDev = (process.env.DEV_AUTH_BYPASS === "true" || process.env.DEV_AUTH_BYPASS === true) && process.env.NODE_ENV !== "production";
        if (isDev) return true;

        const { data: media, error } = await supabase
            .from("media")
            .select("id, project:project!project_id(user_id)")
            .eq("id", mediaId)
            .single();

        if (error || !media || !media.project?.user_id || media.project?.user_id !== userId) return false;
        return true;
    }
}
