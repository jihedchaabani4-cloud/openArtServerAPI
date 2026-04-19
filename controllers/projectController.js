import { supabase } from "../lib/supabase.js";
import { MODEL_FAMILIES, getModelMetadata } from "../src/utils/modelUtils.js";
import { getWorkflows } from "./workflowsController.js";
import { MODEL_ROUTES } from "#video/core/modelRouter.js";
import { IMAGE_ROUTES } from "#image/core/modelRouter.js";

function videoModelInfoToPayload(key, route) {
    const info = route.info || {};
    return {
        key:            key,
        displayName:    info.displayName || key,
        description:    info.description || "",
        category:       info.category || "video",
        tier:           info.tier,
        pricing:        info.pricing,
        tags:           info.tags || [],
        supportedModes: info.supportedModes || [],
        support:        info.support || {},
        supportsEdit:   route.supportsEdit,
        supportsCamera: route.supportsCamera,
        icon:           info.icon || getModelMetadata(key).iconUrl,
    };
}

function getModelConfig() {
    const videoModels = Object.entries(MODEL_ROUTES)
        .filter(([_, route]) => route.type === "generated" && route.open !== false)
        .map(([key, route]) => videoModelInfoToPayload(key, route));
    const imageModels = Object.entries(IMAGE_ROUTES)
        .filter(([_, route]) => route.open !== false)
        .map(([key, route]) => {
        const group = route.group;
        return {
            key,
            displayName: group.displayName,
            description: group.description || "",
            category:    group.category,
            tier:        group.tier,
            pricing:     group.pricing,
            tags:        group.tags || [],
            support:     group.support || {},
            supportsEdit: route.supportsEdit,
            supportsCamera: route.supportsCamera,
            variants: {
                t2i:      !!route.t2i,
                i2i:      !!route.i2i,
                i2iMulti: !!route.i2iMulti,
            },
            icon: group.icon || getModelMetadata(key).iconUrl,
        };
    });

    const models   = [...videoModels, ...imageModels];

    return {
        models,
    };
}

export const getProjectData = async (req, res) => {
    try {
        const { project_id } = req.params;
        const modelConfig    = getModelConfig();
        if (!project_id || project_id === "null" || project_id === "undefined") {
            return res.json({
                result: { data: { json: {
                    projectContents: { sessions: [], workflows: [], media: [] },
                    modelConfig,
                }}},
            });
        }

        // ── 1. Project ──────────────────────────────────────────────
        const { data: projectData } = await supabase
            .from("project")
            .select("name")
            .eq("id", project_id)
            .single();
        const projectName = projectData?.name || "Unknown Project";

        // ── 2. Sessions ─────────────────────────────────────────────
        const { data: sessions } = await supabase
            .from("session")
            .select("id, name, position, create_time")
            .eq("project_id", project_id)
            .order("position", { ascending: true });

        const formattedSessions = (sessions || []).map(s => ({
            name:      s.id,
            projectId: project_id,
            metadata: {
                displayName: s.name || "Untitled Session",
                createTime:  s.create_time,
                position:    s.position,
            },
        }));

        // ── 3. Workflows ─────────────────────────────────────────────
        const workflows = await getWorkflows(
            { project_id },
            {
                select: "id, display_name, variation_index, primary_media_id, create_time, session_id, favorited, workflow_type",
                order:  { column: "create_time", ascending: false },
            }
        ).catch(err => {
            console.error("❌ Workflow query error:", err);
            return [];
        });

        const formattedWorkflows = (workflows || []).map(wf => ({
            name:          wf.id,
            projectId:     project_id,
            workflow_type: wf.workflow_type,
            metadata: {
                displayName:    wf.display_name,
                createTime:     wf.create_time,
                primaryMediaId: wf.primary_media_id || "",
                sessionId:      wf.session_id,
                favorited:      !!wf.favorited,
            },
        }));

        // ── 4. Media ───────────────────────────────────────────────
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
            .eq("project_id", project_id)
            .order("create_time", { ascending: false });

        if (mediaError) console.error("❌ Media query error:", mediaError);

        const formattedMedia = (mediaItems || []).map(m => {
            const config  = m.generation_config;
            const refs    = (config?.references || []).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
            const isVideo  = m.url && /\.(mp4|webm|mov)$/i.test(m.url);
            const isUpload = !m.generation_config_id;

            // ── imageGenerationImageInputs ────────────────────────
            const imageGenerationImageInputs = isUpload ? undefined : refs.map(ref => ({
                imageInputType: ref.input_type || "IMAGE_INPUT_TYPE_BASE_IMAGE",
                mediaId:        ref.ref_media_id,
            }));

            // ── structuredPrompt parts ────────────────────────────
            const promptParts = [];
            if (config?.prompt) {
                promptParts.push({ text: config.prompt });
            }
            refs.forEach(ref => {
                if (ref.ref_media?.url) {
                    promptParts.push({
                        reference: {
                            media: {
                                mediaId: ref.ref_media_id,
                                url:     ref.ref_media.url,
                            },
                        },
                    });
                }
            });

            // ── mediaObject ───────────────────────────────────────
            const mediaObject = {
                name:           m.id,
                url:            m.url,
                status:         m.status || (m.url ? "success" : "processing"),
                error:          m.error_message || null,
                projectId:      project_id,
                workflowId:     m.workflow_id,
                workflowStepId: isUpload ? "upload" : (m.step_id || "CAE"),

                generationConfig: config ? {
                    prompt:         config.prompt          || "",
                    model:          config.model           || "",
                    aspectRatio:    config.aspect_ratio    || "",
                    generationType: config.generation_type || "",
                    seed:           config.seed ?? null,
                    references: refs.map(ref => ({
                        url:      ref.ref_media?.url || "",
                        asset_id: ref.ref_media_id,
                        role:     ref.input_type || "IMAGE_INPUT_TYPE_BASE_IMAGE",
                    })),
                    dna: config.dna && config.dna.length > 0 ? config.dna[0] : null,
                } : null,

                mediaMetadata: {
                    createTime: m.create_time,
                    requestData: {
                        promptInputs: config?.prompt
                            ? [{
                                textInput:        config.prompt,
                                structuredPrompt: { parts: promptParts },
                            }]
                            : [],
                        clientPlatform: "CLIENT_PLATFORM_WEB",
                        imageGenerationRequestData:  isUpload ? undefined : {},
                        imageGenerationImageInputs,
                    },
                    visibility: config?.visibility || "PRIVATE",
                },
            };

            // ── video / image ─────────────────────────────────────
            if (isVideo) {
                mediaObject.video = {
                    generatedVideo: config ? {
                        seed:        config.seed ?? null,
                        model:       config.model || "",
                        prompt:      config.prompt || "",
                        aspectRatio: config.aspect_ratio || "",
                        url:         m.url,
                    } : null,
                    dimensions: { width: m.width || 1280, height: m.height || 720 },
                };
            } else {
                mediaObject.image = {
                    generatedImage: !isUpload && config ? {
                        seed:          config.seed ?? null,
                        prompt:        config.prompt || "",
                        modelNameType: config.model  || "",
                        workflowId:    m.workflow_id,
                        aspectRatio:   config.aspect_ratio || "",
                        url:           m.url,
                    } : null,
                    userUploadedImage: isUpload
                        ? { aspectRatio: "IMAGE_ASPECT_RATIO_UNSPECIFIED" }
                        : undefined,
                    dimensions: { width: m.width || 1024, height: m.height || 1024 },
                };
            }

            return mediaObject;
        });

        // ── 5. Response ─────────────────────────────────────────────
        return res.json({
            result: {
                data: {
                    json: {
                        projectName,
                        projectId:  project_id,
                        appConfig:  { changeLogId: "2026-03-19-v1-3f4e036c-6a67-467f-a0e6-25cff0a0a8ab" },
                        modelConfig,
                        projectContents: {
                            sessions:  formattedSessions,
                            workflows: formattedWorkflows,
                            media:     formattedMedia,
                        },
                    },
                },
            },
        });

    } catch (err) {
        console.error("Error fetching project data:", err);
        res.status(500).json({ ok: false, message: err.message });
    }
};