import { projectReadService } from "../src/container.js";
import { APP_PRICING } from "../src/config/pricing.js";
import { calculateCost, getCatalog } from "../src/models/index.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeCalculateCost(modelKey, operation, input) {
    try {
        return calculateCost(modelKey, operation, input);
    } catch {
        return null; // Model not in V2 registry yet — degrade gracefully
    }
}

// ── Model config (HTTP-layer concern: computed from registry per request) ──────

function getModelConfig() {
    const catalog = getCatalog();

    const models = catalog.map((m) => {
        const isVideo = m.domain === "video";
        const opDetails = m.operationDetails || {};
        const mainOp = isVideo ? "text_to_video" : (opDetails.text_to_image ? "text_to_image" : Object.keys(opDetails)[0]);
        const opDef = opDetails[mainOp] || {};
        const defaultCost = safeCalculateCost(
            m.modelFamily,
            mainOp,
            isVideo ? { durationSeconds: 5, resolution: "720p" } : { quality: "standard" }
        );

        return {
            key:            m.modelFamily,
            displayName:    m.displayName,
            description:    m.description || "",
            category:       m.domain,
            tier:           m.badge || "standard",
            pricing:        { ...(opDef.pricing || {}), defaultCost },
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
