import { supabase, supabaseAdmin } from "../../../lib/supabase.js";
import { getCatalog } from "../../models/index.js";
import { crudOperationLog, CrudServiceError } from "../../utils/crudOperationLog.js";

function getCatalogPricing() {
    const catalog = getCatalog();
    const pricing = {};
    for (const m of catalog) {
        for (const [op, details] of Object.entries(m.operationDetails || {})) {
            if (details.pricing) {
                pricing[`${m.modelFamily}.${op}`] = details.pricing;
            }
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

function getModelConfig() {
    const catalog = getCatalog();

    const models = catalog.map((m) => {
        const isVideo = m.domain === "video";
        const opDetails = m.operationDetails || {};
        const mainOp = isVideo ? "text_to_video" : (opDetails.text_to_image ? "text_to_image" : Object.keys(opDetails)[0]);
        const opDef = opDetails[mainOp] || {};

        return {
            key:            m.modelFamily,
            displayName:    m.displayName,
            description:    m.description || "",
            category:       m.domain,
            tier:           m.badge || "standard",
            pricing:        opDef.pricing || {},
            tags:           m.badge ? [m.badge.toLowerCase()] : [],
            supportedModes: m.operations || [],
            support:        {},
            supportsEdit:   m.operations.includes("edit"),
            supportsCamera: isVideo,
            variants: {
                t2i:      m.operations.includes("text_to_image"),
                i2i:      m.operations.includes("edit"),
                i2iMulti: m.operations.includes("edit"),
            },
            icon:           m.iconUrl || "",
            badge:          m.badge || null,
        };
    });

    return { models };
}

function normalizeMediaStatus(status, url) {
    return status || (url ? "success" : "processing");
}

export class ProjectReadService {
    constructor({ db }) {
        this.db = db;
    }

    async getProjectData({ projectId, userId, sessionId = null }) {
        const started = Date.now();
        const operation = "getProjectData";
        const modelConfig = getModelConfig();

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

        if (projectData.user_id && projectData.user_id !== userId) {
            const isDev = process.env.DEV_AUTH_BYPASS === "true" || process.env.DEV_AUTH_BYPASS === true;
            if (!isDev) {
                throw new CrudServiceError("Unauthorized access to this project", {
                    statusCode: 403,
                    errorCode: "FORBIDDEN",
                });
            }
        }

        const projectName = projectData?.project_name || "Unknown Project";

        const { data: sessions } = await supabase
            .from("session")
            .select("id, name, position, create_time")
            .eq("project_id", projectId)
            .order("position", { ascending: true });

        const formattedSessions = (sessions || []).map((s) => ({
            name: s.id,
            projectId,
            metadata: {
                displayName: s.name || "Untitled Session",
                createTime: s.create_time,
                position: s.position,
            },
        }));

        const workflows = await this.db.workflows
            .findByProject(projectId, {
                select: "id, display_name, variation_index, primary_media_id, create_time, session_id, favorited, workflow_type",
                order: { column: "create_time", ascending: false },
            })
            .catch((err) => {
                console.error("❌ Workflow query error:", err);
                return [];
            });

        const workflowIds = (workflows || []).map((w) => w.id);
        let elementMap = {};
        let characterMap = {};
        let elementsList = [];
        let charactersList = [];

        if (workflowIds.length > 0) {
            const { data: elements, error: elemErr } = await supabase
                .from("element")
                .select("*")
                .in("workflow_id", workflowIds);

            if (elemErr) {
                console.warn("⚠️ Element query warning:", elemErr.message);
            } else if (elements) {
                elementsList = elements;
                elements.forEach((elem) => {
                    elementMap[elem.workflow_id] = elem;
                });
            }

            const { data: chars, error: charErr } = await supabaseAdmin
                .from("characters")
                .select("*")
                .or(`project_id.eq.${projectId},workflow_id.in.(${workflowIds.join(",")})`);

            if (charErr) {
                console.warn("⚠️ Characters query warning:", charErr.message);
            } else if (chars) {
                charactersList = chars;
                chars.forEach((c) => {
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
                chars.forEach((c) => {
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
                projectId,
                workflow_type: wf.workflow_type,
                metadata: {
                    displayName,
                    createTime: wf.create_time,
                    primaryMediaId: wf.primary_media_id || "",
                    sessionId: wf.session_id,
                    favorited: !!wf.favorited,
                },
            };
        });

        const { data: mediaItems, error: mediaError } = await supabase
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
            .order("create_time", { ascending: false });

        if (mediaError) console.error("❌ Media query error:", mediaError);

        const formattedMedia = (mediaItems || []).map((m) => {
            const config = m.generation_config;
            const refs = (config?.references || []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
            const isVideo = m.url && /\.(mp4|webm|mov)$/i.test(m.url);
            const isUpload = !m.generation_config_id;

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
                workflowId: m.workflow_id,
                workflow_id: m.workflow_id,
                step_id: m.step_id,
                workflowStepId: m.step_id || (isUpload ? "upload" : "GEN"),
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

            if (isVideo) {
                mediaObject.video = {
                    generatedVideo: config
                        ? {
                              seed: config.seed ?? null,
                              model: config.model || "",
                              prompt: config.prompt || "",
                              aspectRatio: config.aspect_ratio || "",
                              url: m.url,
                          }
                        : null,
                    dimensions: { width: m.width || 1280, height: m.height || 720 },
                };
            } else {
                mediaObject.image = {
                    generatedImage:
                        !isUpload && config
                            ? {
                                  seed: config.seed ?? null,
                                  prompt: config.prompt || "",
                                  modelNameType: config.model || "",
                                  workflowId: m.workflow_id,
                                  aspectRatio: config.aspect_ratio || "",
                                  url: m.url,
                              }
                            : null,
                    userUploadedImage: isUpload ? { aspectRatio: "IMAGE_ASPECT_RATIO_UNSPECIFIED" } : undefined,
                    dimensions: { width: m.width || 1024, height: m.height || 1024 },
                };
            }

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
            throw new CrudServiceError("Unauthorized access to this media", {
                statusCode: 403,
                errorCode: "FORBIDDEN",
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
        const secret = req?.headers?.["x-internal-secret"];
        const isInternal = secret && secret === (process.env.INTERNAL_SECRET || "openart_internal_s2s_secret_2026");
        const isDev = process.env.DEV_AUTH_BYPASS === "true" || process.env.DEV_AUTH_BYPASS === true;

        if (isInternal || isDev) return true;

        const { data: media, error } = await supabase
            .from("media")
            .select("id, project:project!project_id(user_id)")
            .eq("id", mediaId)
            .single();

        if (error || !media || (media.project?.user_id && media.project?.user_id !== userId)) return false;
        return true;
    }
}
