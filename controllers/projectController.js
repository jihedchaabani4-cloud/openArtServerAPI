import { projectReadService } from "../src/container.js";
import { MODEL_ROUTES } from "#video/core/modelRouter.js";
import { IMAGE_ROUTES } from "#image/core/modelRouter.js";
import { getModelMetadata } from "../src/utils/modelUtils.js";
import { APP_PRICING } from "../src/config/pricing.js";

// ── Model config (HTTP-layer concern: computed from registry per request) ──────

function videoModelInfoToPayload(key, route) {
    const info = route.info || {};
    return {
        key:            key,
        displayName:    info.displayName || key,
        description:    info.description || "",
        category:       info.category || "video",
        tier:           info.tier,
        pricing:        route.pricing,
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
        .filter(([_, route]) => route.type === "generated" && route.open !== false && !route.hidden)
        .map(([key, route]) => videoModelInfoToPayload(key, route));

    const imageModels = Object.entries(IMAGE_ROUTES)
        .filter(([_, route]) => route.open !== false && !route.hidden)
        .map(([key, route]) => {
            const group = route.group;
            return {
                key,
                displayName: group.displayName,
                description: group.description || "",
                category:    group.category,
                tier:        group.tier,
                pricing:     route.pricing,
                tags:        group.tags || [],
                support:     group.support || {},
                supportsEdit:   route.supportsEdit,
                supportsCamera: route.supportsCamera,
                variants: {
                    t2i:      !!route.t2i,
                    i2i:      !!route.i2i,
                    i2iMulti: !!route.i2iMulti,
                },
                icon: group.icon || getModelMetadata(key).iconUrl,
            };
        });

    return { models: [...videoModels, ...imageModels] };
}

// ── GET /workflows/project-data/:project_id ───────────────────────────────────
// Thin HTTP adapter — delegates all aggregation to ProjectReadService

export const getProjectData = async (req, res) => {
    try {
        const { project_id } = req.params;
        const modelConfig    = getModelConfig();

        if (!project_id || project_id === "null" || project_id === "undefined") {
            return res.json({
                result: { data: { json: {
                    projectContents: { sessions: [], workflows: [], media: [] },
                    modelConfig,
                    appConfig: {
                        changeLogId: "2026-03-19-v1-3f4e036c-6a67-467f-a0e6-25cff0a0a8ab",
                        pricing: APP_PRICING,
                    },
                }}},
            });
        }

        const userId = req.user.id;

        // Delegate to ProjectReadService — all business logic lives there
        const data = await projectReadService.getProjectData({ projectId: project_id, userId });

        return res.json({
            result: {
                data: {
                    json: {
                        projectName:  data.projectName,
                        projectId:    project_id,
                        appConfig: {
                            changeLogId: "2026-03-19-v1-3f4e036c-6a67-467f-a0e6-25cff0a0a8ab",
                            pricing: APP_PRICING,
                        },
                        modelConfig,
                        projectContents: {
                            sessions:   data.sessions,
                            workflows:  data.workflows,
                            media:      data.media,
                            elements:   data.elements,
                            characters: data.characters,
                        },
                    },
                },
            },
        });

    } catch (err) {
        console.error("Error fetching project data:", err);
        const statusCode = err.statusCode || 500;
        res.status(statusCode).json({ ok: false, message: err.message });
    }
};
