/**
 * elementController
 * Thin HTTP adapter for the Element Reference System.
 * All business logic lives in ElementService / ElementMediaService.
 *
 * Feature: 018-element-reference-system
 */

import { randomUUID } from "node:crypto";
import { elementService, elementMediaService } from "../src/container.js";
import { assertOwns } from "../src/platform/security/ownership.js";

// ─── Logging helpers ──────────────────────────────────────────────────────────

function structuredLog({ traceId, operation, durationMs, status, errorCode, message } = {}) {
    const entry = {
        timestamp:  new Date().toISOString(),
        traceId:    traceId || randomUUID(),
        operation,
        durationMs: durationMs ?? null,
        status,
    };
    if (errorCode !== undefined) entry.errorCode = errorCode;
    if (message   !== undefined) entry.message   = message;
    return entry;
}

function logOk(traceId, operation, start) {
    console.log(JSON.stringify(structuredLog({ traceId, operation, durationMs: Date.now() - start, status: "success" })));
}

function logErr(traceId, operation, start, err) {
    const statusCode = err.statusCode || 500;
    console.error(JSON.stringify(structuredLog({ traceId, operation, durationMs: Date.now() - start, status: "error", errorCode: statusCode, message: err.message })));
    return statusCode;
}

// ─── POST /api/v2/elements ────────────────────────────────────────────────────

/** Create a new Element. Body: { name, sourceImages[1-6], description?, projectId, tags?, userId? } */
export async function createElement(req, res) {
    const traceId = randomUUID();
    const start   = Date.now();
    const op      = "POST /api/v2/elements";

    try {
        const { name, sourceImages, description, tags, element_type, type } = req.body;
        const projectId = req.body.projectId || req.body.project_id;
        const userId = req.user?.id || req.body.userId;

        if (projectId && userId) {
            await assertOwns("project", projectId, userId);
        }

        const result = await elementService.createElement({ name, sourceImages, description, projectId, tags, userId, element_type, type });

        logOk(traceId, op, start);
        return res.status(201).json({ status: "created", ...result });
    } catch (err) {
        return res.status(logErr(traceId, op, start, err)).json({ error: true, message: err.message });
    }
}

// ─── GET /api/v2/elements/project/:projectId ──────────────────────────────────

/** List all Elements for a project. */
export async function listProjectElements(req, res) {
    const traceId = randomUUID();
    const start   = Date.now();
    const op      = "GET /api/v2/elements/project/:projectId";

    try {
        const userId = req.user?.id;
        if (userId) {
            await assertOwns("project", req.params.projectId, userId);
        }

        const elements = await elementService.listProjectElements(req.params.projectId);

        logOk(traceId, op, start);
        return res.json({ status: "success", count: elements.length, elements });
    } catch (err) {
        return res.status(logErr(traceId, op, start, err)).json({ error: true, message: err.message });
    }
}

// ─── GET /api/v2/elements/:id ─────────────────────────────────────────────────

/** Retrieve full Element details with all reference images. */
export async function getElementById(req, res) {
    const traceId = randomUUID();
    const start   = Date.now();
    const op      = "GET /api/v2/elements/:id";

    try {
        const userId = req.user?.id;
        if (userId) {
            await assertOwns("element", req.params.id, userId);
        }

        const element = await elementService.getElementById(req.params.id);

        if (!element) {
            console.warn(JSON.stringify(structuredLog({ traceId, operation: op, durationMs: Date.now() - start, status: "not_found", errorCode: 404 })));
            return res.status(404).json({ error: true, message: `Element not found: ${req.params.id}` });
        }

        logOk(traceId, op, start);
        return res.json({ status: "success", element });
    } catch (err) {
        return res.status(logErr(traceId, op, start, err)).json({ error: true, message: err.message });
    }
}

// ─── PATCH /api/v2/elements/:id ───────────────────────────────────────────────

/** Partial update — only provided fields are written. element_type is immutable. */
export async function updateElement(req, res) {
    const traceId = randomUUID();
    const start   = Date.now();
    const op      = "PATCH /api/v2/elements/:id";

    try {
        const userId = req.user?.id;
        if (userId) {
            await assertOwns("element", req.params.id, userId);
        }

        const updated = await elementService.updateElement(req.params.id, req.body || {});

        logOk(traceId, op, start);
        return res.json({ status: "success", element: updated });
    } catch (err) {
        return res.status(logErr(traceId, op, start, err)).json({ error: true, message: err.message });
    }
}

// ─── DELETE /api/v2/elements/:id ─────────────────────────────────────────────

/** Delete an Element and its associated workflow & storage files. */
export async function deleteElement(req, res) {
    const traceId = randomUUID();
    const start   = Date.now();
    const op      = "DELETE /api/v2/elements/:id";

    try {
        const userId = req.user?.id;
        if (userId) {
            await assertOwns("element", req.params.id, userId);
        }

        await elementService.deleteElement(req.params.id, req.user?.id);

        logOk(traceId, op, start);
        return res.json({ status: "success", deleted: true, id: req.params.id });
    } catch (err) {
        return res.status(logErr(traceId, op, start, err)).json({ error: true, message: err.message });
    }
}

// ─── POST /api/v2/elements/:id/images ────────────────────────────────────────

/** Add a single reference image (URL, file upload, or mediaId) to an element. */
export async function addImageToElement(req, res) {
    const traceId = randomUUID();
    const start   = Date.now();
    const op      = "POST /api/v2/elements/:id/images";

    try {
        const { imageUrl, mediaId } = req.body;
        const projectId = req.body.projectId || req.body.project_id;
        const userId = req.user?.id || req.body.userId;
        const file   = req.file;

        if (!imageUrl && !file && !mediaId) {
            return res.status(400).json({ error: true, message: "imageUrl, file, or mediaId is required" });
        }

        if (userId) {
            await assertOwns("element", req.params.id, userId);
        }

        const result = await elementMediaService.addReferenceMedia({
            elementId: req.params.id, imageUrl, file, mediaId, projectId, userId,
        });

        logOk(traceId, op, start);
        return res.status(201).json({ status: "created", media: result.media });
    } catch (err) {
        return res.status(logErr(traceId, op, start, err)).json({ error: true, message: err.message });
    }
}

// ─── DELETE /api/v2/elements/:id/images/:mediaId ─────────────────────────────

/** Remove a single reference image from an element. */
export async function removeImageFromElement(req, res) {
    const traceId = randomUUID();
    const start   = Date.now();
    const op      = "DELETE /api/v2/elements/:id/images/:mediaId";

    try {
        const { id, mediaId } = req.params;
        const userId = req.user?.id;
        if (userId) {
            await assertOwns("element", id, userId);
        }

        const result = await elementMediaService.removeReferenceMedia({ elementId: id, mediaId, userId: req.user?.id, req });

        logOk(traceId, op, start);
        return res.json({ status: "success", ...result });
    } catch (err) {
        return res.status(logErr(traceId, op, start, err)).json({ error: true, message: err.message });
    }
}

// ─── POST /api/v2/elements/analyze ───────────────────────────────────────────

/** Trigger Vision AI analysis for an element. */
export async function analyzeElement(req, res) {
    const traceId = randomUUID();
    const start   = Date.now();
    const op      = "POST /api/v2/elements/analyze";

    try {
        const { projectId, workflowId, imageUrls = [], elementName, elementType } = req.body;
        const userId = req.user?.id;
        if (userId && projectId) {
            await assertOwns("project", projectId, userId);
        }
        if (userId && workflowId) {
            await assertOwns("workflow", workflowId, userId);
        }

        const result = await elementService.analyzeElement({
            projectId,
            workflowId,
            imageUrls,
            elementName,
            elementType,
            userId,
        });

        logOk(traceId, op, start);
        return res.json({ status: "success", ...result });
    } catch (err) {
        return res.status(logErr(traceId, op, start, err)).json({ error: true, message: err.message });
    }
}

// ─── POST /api/v2/elements/build-prompt ──────────────────────────────────────

/** Resolve @ElementName tokens and build generation prompt payload. */
export async function buildPrompt(req, res) {
    const traceId = randomUUID();
    const start   = Date.now();
    const op      = "POST /api/v2/elements/build-prompt";

    try {
        const { userPrompt, elements = [], elementIds = [], projectId } = req.body;
        const payload = await elementService.buildPromptPayload({ userPrompt, elements, elementIds, projectId });

        logOk(traceId, op, start);
        return res.json({ status: "success", ...payload });
    } catch (err) {
        return res.status(logErr(traceId, op, start, err)).json({ error: true, message: err.message });
    }
}
