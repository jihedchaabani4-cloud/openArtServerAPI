/**
 * ProjectReadService
 * @owns System 8: Workspace — project read and aggregation service
 */
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
    constructor({ db, folderService = null }) {
        this.db = db;
        this.folderService = folderService;
    }

    async getProjectData({ projectId, userId }) {
        const started = Date.now();
        const operation = "getProjectData";

        if (!projectId || projectId === "null" || projectId === "undefined") {
            crudOperationLog({ operation, status: "ok", durationMs: Date.now() - started });
            return {
                projectName: "Unknown Project",
                projectId: null,
                workflows: [],
                trashedWorkflows: [],
                media: [],
                elements: [],
                characters: [],
                folders: [],
                collections: [],
            };
        }

        let projectData = null;
        try {
            if (this.db?.projects?.findById) {
                projectData = await this.db.projects.findById(projectId, "project_name, user_id");
            } else {
                const query = supabase
                    .from("project")
                    .select("project_name, user_id")
                    .eq("id", projectId);
                const res = typeof query.maybeSingle === "function"
                    ? await query.maybeSingle()
                    : await query.single().catch(() => ({ data: null }));
                projectData = res?.data || null;
            }
        } catch (err) {
            projectLogger.error({ event: "project_read.project_query_error", err: err?.message || String(err) }, "Project query error");
            throw new CrudServiceError("Project not found", { statusCode: 404, errorCode: "PROJECT_NOT_FOUND" });
        }

        if (!projectData) {
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

        // Fetch workflows, media, and folders concurrently to minimize latency
        const [workflowsResult, mediaResult, foldersResult] = await Promise.all([
            this.db?.workflows?.findByProject
                ? this.db.workflows
                      .findByProject(projectId, {
                          select: "id, display_name, create_time, favorited, workflow_type, folder_id",
                          order: { column: "create_time", ascending: false },
                          partitioned: true,
                      })
                      .catch((err) => {
                          projectLogger.error({ event: "project_read.workflow_query_error", err: err?.message || String(err) }, "Workflow query error");
                          return { active: [], trashed: [] };
                      })
                : { active: [], trashed: [] },
            this.db?.media?.findByProjectAll
                ? this.db.media
                      .findByProjectAll(projectId)
                      .catch((err) => {
                          projectLogger.error({ event: "project_read.media_query_error", err: err?.message || String(err) }, "Media query error");
                          return [];
                      })
                : supabase
                      .from("media")
                      .select("id, step_id, url, width, height, create_time, status, error_message, generation_config")
                      .eq("project_id", projectId)
                      .order("create_time", { ascending: false })
                      .then((r) => r.data || [])
                      .catch(() => []),
            this.folderService?.list
                ? this.folderService.list({ projectId, userId }).then((r) => r.items || []).catch(() => [])
                : this.db?.folders?.listByProject
                    ? this.db.folders.listByProject(projectId, userId).catch(() => [])
                    : (supabaseAdmin || supabase)
                          .from("folders")
                          .select("*")
                          .eq("project_id", projectId)
                          .order("position", { ascending: true })
                          .order("create_time", { ascending: true })
                          .then((r) => r.data || [])
                          .catch(() => []),
        ]);

        const workflows = Array.isArray(workflowsResult)
            ? workflowsResult
            : (workflowsResult?.active || []);
        const rawTrashedWorkflows = Array.isArray(workflowsResult)
            ? []
            : (workflowsResult?.trashed || []);

        const mediaItems = mediaResult || [];

        const workflowIds = (workflows || []).map((w) => w.id);
        const trashedWorkflowIds = (rawTrashedWorkflows || []).map((w) => w.id);
        const trashedWorkflowIdSet = new Set(trashedWorkflowIds);
        const allWorkflowIds = [...workflowIds, ...trashedWorkflowIds];

        let elementMap = {};
        let characterMap = {};
        let elementsList = [];
        let charactersList = [];
        const primaryMediaByWorkflowId = new Map();
        const workflowMediaRelationByMediaId = new Map();
        const relationsByMediaId = new Map();

        if (allWorkflowIds.length > 0) {
            const [elemResult, charResult, relationResult] = await Promise.all([
                workflowIds.length > 0 && this.db.elements?.findByWorkflowIds
                    ? this.db.elements.findByWorkflowIds(workflowIds).catch((err) => {
                          projectLogger.warn({ event: "project_read.element_query_warn", err: err?.message || String(err) }, "Element query warning");
                          return [];
                      })
                    : workflowIds.length > 0
                        ? supabase
                              .from("element")
                              .select("*")
                              .in("workflow_id", workflowIds)
                              .then((r) => r.data || [])
                              .catch(() => [])
                        : Promise.resolve([]),
                workflowIds.length > 0 && this.db.characters?.findByProjectOrWorkflowIds
                    ? this.db.characters.findByProjectOrWorkflowIds({ projectId, workflowIds }).catch((err) => {
                          projectLogger.warn({ event: "project_read.character_query_warn", err: err?.message || String(err) }, "Characters query warning");
                          return [];
                      })
                    : workflowIds.length > 0
                        ? (supabaseAdmin || supabase)
                              .from("characters")
                              .select("*")
                              .or(`project_id.eq.${projectId},workflow_id.in.(${workflowIds.join(",")})`)
                              .then((r) => r.data || [])
                              .catch(() => [])
                        : Promise.resolve([]),
                this.db.workflowMedia?.findRelationsByWorkflowIds
                    ? this.db.workflowMedia.findRelationsByWorkflowIds(allWorkflowIds).catch((err) => {
                          projectLogger.warn(
                              { event: "project_read.workflow_media_query_warn", err: err?.message || String(err) },
                              "Workflow media relation query warning"
                          );
                          return [];
                      })
                    : supabase
                          .from("workflow_media")
                          .select("workflow_id, media_id, role, is_primary, metadata, created_at")
                          .in("workflow_id", allWorkflowIds)
                          .then((r) => r.data || [])
                          .catch(() => []),
            ]);

            elementsList = elemResult || [];
            elementsList.forEach((elem) => {
                elementMap[elem.workflow_id] = elem;
            });

            charactersList = charResult || [];
            charactersList.forEach((c) => {
                if (c.workflow_id) characterMap[c.workflow_id] = c;
                if (c.id) characterMap[c.id] = c;
            });

            for (const row of relationResult || []) {
                if (row?.media_id) {
                    workflowMediaRelationByMediaId.set(row.media_id, row);
                    if (!relationsByMediaId.has(row.media_id)) {
                        relationsByMediaId.set(row.media_id, []);
                    }
                    relationsByMediaId.get(row.media_id).push(row);
                }
                if (row?.is_primary && row?.workflow_id && row?.media_id) {
                    primaryMediaByWorkflowId.set(row.workflow_id, row.media_id);
                }
            }
        } else {
            // Also fetch characters directly by project_id when no workflows exist yet
            if (this.db.characters?.findByProjectOrWorkflowIds) {
                try {
                    const chars = await this.db.characters.findByProjectOrWorkflowIds({ projectId });
                    charactersList = chars || [];
                    charactersList.forEach((c) => {
                        if (c.workflow_id) characterMap[c.workflow_id] = c;
                        if (c.id) characterMap[c.id] = c;
                    });
                } catch (charErr) {
                    projectLogger.warn({ event: "project_read.character_query_warn", err: charErr?.message || String(charErr) }, "Characters query warning");
                }
            } else if (supabaseAdmin || supabase) {
                const { data: chars } = await (supabaseAdmin || supabase)
                    .from("characters")
                    .select("*")
                    .eq("project_id", projectId);
                charactersList = chars || [];
                charactersList.forEach((c) => {
                    if (c.workflow_id) characterMap[c.workflow_id] = c;
                    if (c.id) characterMap[c.id] = c;
                });
            }
        }

        // Backward compatibility fallback for legacy wf.primary_media_id pins
        for (const wf of [...(workflows || []), ...(rawTrashedWorkflows || [])]) {
            if (wf?.primary_media_id && !primaryMediaByWorkflowId.has(wf.id)) {
                primaryMediaByWorkflowId.set(wf.id, wf.primary_media_id);
            }
        }

        const formattedWorkflows = (workflows || []).map((wf) => {
            const elem = elementMap[wf.id] || {};
            const char = characterMap[wf.id] || {};
            const displayName = char.name || char.title || elem.name || wf.display_name || "Untitled Workflow";
            const primaryMediaId = primaryMediaByWorkflowId.get(wf.id) || wf.primary_media_id || "";

            return {
                id: wf.id,
                name: wf.id,
                display_name: displayName,
                projectId,
                workflow_type: wf.workflow_type,
                folder_id: wf.folder_id || null,
                folderId: wf.folder_id || null,
                primary_media_id: primaryMediaId,
                primaryMediaId: primaryMediaId,
                metadata: {
                    displayName,
                    createTime: wf.create_time,
                    primaryMediaId: primaryMediaId,
                    favorited: !!wf.favorited,
                    folder_id: wf.folder_id || null,
                    folderId: wf.folder_id || null,
                },
            };
        });

        const workflowMap = new Map((workflows || []).map((w) => [w.id, w]));
        const trashedWorkflowMap = new Map((rawTrashedWorkflows || []).map((w) => [w.id, w]));
        const workflowsByPrimaryMediaId = new Map(
            (workflows || [])
                .filter((w) => primaryMediaByWorkflowId.has(w.id) || w?.primary_media_id)
                .map((w) => [primaryMediaByWorkflowId.get(w.id) || w.primary_media_id, w])
        );
        const trashedByPrimaryMediaId = new Map(
            (rawTrashedWorkflows || [])
                .filter((w) => primaryMediaByWorkflowId.has(w.id) || w?.primary_media_id)
                .map((w) => [primaryMediaByWorkflowId.get(w.id) || w.primary_media_id, w])
        );
        const trashedMediaByWorkflowId = new Map();

        const formattedMedia = [];
        for (const m of mediaItems || []) {
            const config = Array.isArray(m.generation_config) ? m.generation_config[0] : (m.generation_config || null);
            const refs = (config?.references || []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
            const isVideo = m.url && /\.(mp4|webm|mov)$/i.test(m.url);
            const mRelations = relationsByMediaId.get(m.id) || [];
            const primaryRelation = mRelations[0] || null;
            let mediaWorkflowId = primaryRelation?.workflow_id || null;
            let mediaRole = primaryRelation?.role || null;

            if (!mediaWorkflowId) {
                const owningWf = workflowsByPrimaryMediaId.get(m.id) || trashedByPrimaryMediaId.get(m.id);
                if (owningWf) {
                    mediaWorkflowId = owningWf.id;
                    mediaRole = owningWf.workflow_type === "UPLOAD" ? "original" : "output";
                }
            }

            const isTrashedMedia = trashedWorkflowIdSet.has(mediaWorkflowId);
            const wf = isTrashedMedia ? trashedWorkflowMap.get(mediaWorkflowId) : workflowMap.get(mediaWorkflowId);
            const isUpload = wf?.workflow_type === "UPLOAD" ||
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
                is_primary: Boolean(primaryRelation?.is_primary || (primaryMediaByWorkflowId.get(mediaWorkflowId) === m.id)),
                isPrimary: Boolean(primaryRelation?.is_primary || (primaryMediaByWorkflowId.get(mediaWorkflowId) === m.id)),
                metadata: primaryRelation?.metadata || m.metadata || {},
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
                          parameters: config.parameters ?? {},
                          references: refs.map((ref) => ({
                              url: ref.ref_media?.url || "",
                              asset_id: ref.ref_media_id,
                              role: ref.input_type || "IMAGE_INPUT_TYPE_BASE_IMAGE",
                          })),
                          dna: null,
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

            if (isTrashedMedia) {
                if (!trashedMediaByWorkflowId.has(mediaWorkflowId)) {
                    trashedMediaByWorkflowId.set(mediaWorkflowId, []);
                }
                trashedMediaByWorkflowId.get(mediaWorkflowId).push(mediaObject);
            } else {
                formattedMedia.push(mediaObject);
            }

            for (const otherRel of mRelations.slice(1)) {
                if (otherRel.workflow_id && otherRel.workflow_id !== mediaWorkflowId) {
                    const otherIsTrashed = trashedWorkflowIdSet.has(otherRel.workflow_id);
                    const linkedWf = otherIsTrashed
                        ? trashedWorkflowMap.get(otherRel.workflow_id)
                        : workflowMap.get(otherRel.workflow_id);
                    const authenticStepId = m.step_id;
                    const isOtherUpload = linkedWf?.workflow_type === "UPLOAD" ||
                                         otherRel.role === "original" ||
                                         m.step_id === "CAE" ||
                                         m.step_id === "upload";

                    const otherMediaObj = {
                        ...mediaObject,
                        workflowId: otherRel.workflow_id,
                        workflow_id: otherRel.workflow_id,
                        folder_id: linkedWf?.folder_id || null,
                        folderId: linkedWf?.folder_id || null,
                        role: otherRel.role,
                        mediaRole: otherRel.role,
                        is_primary: Boolean(otherRel.is_primary),
                        isPrimary: Boolean(otherRel.is_primary),
                        metadata: otherRel.metadata || {},
                        step_id: authenticStepId,
                        workflowStepId: authenticStepId || (isOtherUpload ? "upload" : "GEN"),
                    };

                    if (otherIsTrashed) {
                        if (!trashedMediaByWorkflowId.has(otherRel.workflow_id)) {
                            trashedMediaByWorkflowId.set(otherRel.workflow_id, []);
                        }
                        trashedMediaByWorkflowId.get(otherRel.workflow_id).push(otherMediaObj);
                    } else {
                        formattedMedia.push(otherMediaObj);
                    }
                }
            }
        }

        const mediaByWfId = new Map();
        for (const item of formattedMedia) {
            const wId = item.workflowId || item.workflow_id;
            if (wId) {
                if (!mediaByWfId.has(wId)) mediaByWfId.set(wId, []);
                mediaByWfId.get(wId).push(item);
            }
        }

        const workflowsWithItems = formattedWorkflows.map((wf) => {
            const items = mediaByWfId.get(wf.id) || [];
            return {
                ...wf,
                items,
                media: items,
            };
        });

        const formattedTrashedWorkflows = (rawTrashedWorkflows || []).map((wf) => {
            const displayName = wf.display_name || "Untitled Workflow";
            const primaryMediaId = primaryMediaByWorkflowId.get(wf.id) || wf.primary_media_id || "";
            const items = trashedMediaByWorkflowId.get(wf.id) || [];

            return {
                id: wf.id,
                name: wf.id,
                display_name: displayName,
                projectId,
                workflow_type: wf.workflow_type,
                folder_id: wf.folder_id || null,
                folderId: wf.folder_id || null,
                primary_media_id: primaryMediaId,
                primaryMediaId: primaryMediaId,
                deleted_at: wf.deleted_at || null,
                deletedAt: wf.deleted_at || null,
                media: items,
                items,
                metadata: {
                    displayName,
                    createTime: wf.create_time,
                    primaryMediaId: primaryMediaId,
                    favorited: !!wf.favorited,
                    folder_id: wf.folder_id || null,
                    folderId: wf.folder_id || null,
                    deleted_at: wf.deleted_at || null,
                    deletedAt: wf.deleted_at || null,
                },
            };
        });

        const rawFolders = Array.isArray(foldersResult) ? foldersResult : [];
        const formattedFolders = rawFolders.map((f) => {
            const count = f.assetCount !== undefined
                ? f.assetCount
                : (workflows || []).filter((w) => w.folder_id === f.id).length;
            return {
                id: f.id,
                projectId: f.projectId || f.project_id || projectId,
                parentId: f.parentId !== undefined ? f.parentId : (f.parent_id ?? null),
                name: f.name || "Untitled collection",
                color: f.color ?? null,
                description: f.description ?? null,
                position: f.position ?? 0,
                assetCount: count,
                createdAt: f.createdAt || f.create_time || null,
                updatedAt: f.updatedAt || f.updated_at || null,
            };
        });

        crudOperationLog({
            operation,
            status: "ok",
            durationMs: Date.now() - started,
            projectId,
            workflowCount: formattedWorkflows.length,
            mediaCount: formattedMedia.length,
            folderCount: formattedFolders.length,
        });

        return {
            projectName,
            projectId,
            workflows: workflowsWithItems,
            trashedWorkflows: formattedTrashedWorkflows,
            media: formattedMedia,
            elements: elementsList,
            characters: charactersList,
            folders: formattedFolders,
            collections: formattedFolders,
            appConfig: APP_CONFIG,
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

        if (this.db?.media?.findById) {
            await this.db.media.findById(mediaId, "id, project_id, status, url, create_time, error_message");
        }

        let workflowId = null;
        if (this.db?.workflowMedia?.findByMedia) {
            const links = await this.db.workflowMedia.findByMedia(mediaId);
            workflowId = links?.[0]?.workflow_id || null;
        }

        const workflow = workflowId ? await this.db.workflows.getWorkflow(workflowId) : null;
        const items = workflowId ? await this.db.media.findByWorkflow(workflowId) : [];

        crudOperationLog({ operation, status: "ok", durationMs: Date.now() - started, mediaId, workflowId });

        return { workflow, items };
    }

    async _verifyMediaOwnership(mediaId, userId, req = null) {
        const isDev = (process.env.DEV_AUTH_BYPASS === "true" || process.env.DEV_AUTH_BYPASS === true) && process.env.NODE_ENV !== "production";
        if (isDev) return true;

        if (this.db?.media?.findOwnerByMediaId) {
            const ownerId = await this.db.media.findOwnerByMediaId(mediaId);
            if (!ownerId || ownerId !== userId) return false;
            return true;
        }

        const { data: media, error } = await supabase
            .from("media")
            .select("id, project:project!project_id(user_id)")
            .eq("id", mediaId)
            .single();

        if (error || !media || !media.project?.user_id || media.project?.user_id !== userId) return false;
        return true;
    }
}
