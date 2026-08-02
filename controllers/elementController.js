/**
 * Element Controller
 * Thin HTTP adapter for the Element Reference System.
 * Delegates all business logic to elementService.
 * Feature: 018-element-reference-system (V1 Simplified)
 */

import { randomUUID } from "node:crypto";
import * as elementService from "../src/services/elementService.js";
import { addImageToElement as addImageToElementSvc } from "../src/services/elementService.js";
import { ElementAnalysisService } from "../src/services/ElementAnalysisService.js";

// ─── Helper ───────────────────────────────────────────────────────────────────

function structuredLog({ traceId, operation, durationMs, status, errorCode, message } = {}) {
    const entry = {
        timestamp:  new Date().toISOString(),
        traceId:    traceId || randomUUID(),
        operation,
        durationMs: durationMs ?? null,
        status,
    };
    if (errorCode) entry.errorCode = errorCode;
    if (message)   entry.message   = message;
    return entry;
}

// ─── POST /api/v2/elements ────────────────────────────────────────────────────

/**
 * Create a new Element (direct save — no AI generation).
 * Body: { name, sourceImages[1-6], description?, projectId, tags?, userId? }
 */
export async function createElement(req, res) {
    const traceId = randomUUID();
    const start   = Date.now();

    try {
        const { name, sourceImages, description, projectId, tags, element_type, type } = req.body;
        const userId = req.user?.id || req.body.userId;

        const result = await elementService.createElement({
            name,
            sourceImages,
            description,
            projectId,
            tags,
            userId,
            element_type,
            type,
        });

        const durationMs = Date.now() - start;
        console.log(JSON.stringify(structuredLog({ traceId, operation: "POST /api/v2/elements", durationMs, status: "success" })));

        return res.status(201).json({ status: "created", ...result });


    } catch (err) {
        const durationMs = Date.now() - start;
        const statusCode = err.statusCode || 500;
        console.error(JSON.stringify(structuredLog({ traceId, operation: "POST /api/v2/elements", durationMs, status: "error", errorCode: statusCode, message: err.message })));

        return res.status(statusCode).json({ error: true, message: err.message });
    }
}

// ─── GET /api/v2/elements/project/:projectId ──────────────────────────────────

/**
 * List all Elements for a project.
 */
export async function listProjectElements(req, res) {
    const traceId = randomUUID();
    const start   = Date.now();

    try {
        const { projectId } = req.params;
        const elements = await elementService.listProjectElements(projectId);

        const durationMs = Date.now() - start;
        console.log(JSON.stringify(structuredLog({ traceId, operation: "GET /api/v2/elements/project/:projectId", durationMs, status: "success" })));

        return res.json({ status: "success", count: elements.length, elements });

    } catch (err) {
        const durationMs = Date.now() - start;
        console.error(JSON.stringify(structuredLog({ traceId, operation: "GET /api/v2/elements/project/:projectId", durationMs, status: "error", errorCode: 500, message: err.message })));

        return res.status(500).json({ error: true, message: err.message });
    }
}

// ─── GET /api/v2/elements/:id ─────────────────────────────────────────────────

/**
 * Retrieve full Element details with all reference images.
 */
export async function getElementById(req, res) {
    const traceId = randomUUID();
    const start   = Date.now();

    try {
        const { id } = req.params;
        const element = await elementService.getElementById(id);

        if (!element) {
            return res.status(404).json({ error: true, message: `Element not found: ${id}` });
        }

        const durationMs = Date.now() - start;
        console.log(JSON.stringify(structuredLog({ traceId, operation: "GET /api/v2/elements/:id", durationMs, status: "success" })));

        return res.json({ status: "success", element });

    } catch (err) {
        const durationMs = Date.now() - start;
        console.error(JSON.stringify(structuredLog({ traceId, operation: "GET /api/v2/elements/:id", durationMs, status: "error", errorCode: 500, message: err.message })));

        return res.status(500).json({ error: true, message: err.message });
    }
}

// ─── DELETE /api/v2/elements/:id ─────────────────────────────────────────────

/**
 * Delete an Element and its associated media records.
 */
export async function deleteElement(req, res) {
    const traceId = randomUUID();
    const start   = Date.now();

    try {
        const { id } = req.params;
        const userId = req.user?.id;
        await elementService.deleteElement(id, userId);

        const durationMs = Date.now() - start;
        console.log(JSON.stringify(structuredLog({ traceId, operation: "DELETE /api/v2/elements/:id", durationMs, status: "success" })));

        return res.json({ status: "success", deleted: true });

    } catch (err) {
        const durationMs = Date.now() - start;
        const statusCode = err.statusCode || 500;
        console.error(JSON.stringify(structuredLog({ traceId, operation: "DELETE /api/v2/elements/:id", durationMs, status: "error", errorCode: statusCode, message: err.message })));

        return res.status(statusCode).json({ message: err.message });
    }
}
// ─── POST /api/v2/elements/:id/images ────────────────────────────────────────

/**
 * Add a single image (by URL) to an existing element's workflow.
 * Body: { imageUrl, projectId }
 */
export async function addImageToElement(req, res) {
    const traceId = randomUUID();
    const start   = Date.now();

    try {
        const { id }                    = req.params;
        const { imageUrl, projectId }   = req.body;
        const userId                    = req.user?.id || req.body.userId;

        if (!imageUrl) return res.status(400).json({ error: true, message: "imageUrl is required" });

        const media = await addImageToElementSvc({ elementId: id, imageUrl, projectId, userId });

        const durationMs = Date.now() - start;
        console.log(JSON.stringify(structuredLog({ traceId, operation: "POST /api/v2/elements/:id/images", durationMs, status: "success" })));

        return res.status(201).json({ status: "created", media });

    } catch (err) {
        const durationMs = Date.now() - start;
        console.error(JSON.stringify(structuredLog({ traceId, operation: "POST /api/v2/elements/:id/images", durationMs, status: "error", errorCode: 500, message: err.message })));
        return res.status(500).json({ error: true, message: err.message });
    }
}

import elementRepository from "../src/db/ElementRepository.js";

// ─── PATCH /api/v2/elements/:id ──────────────────────────────────────────────

/**
 * Update Element details (element_type, name, description).
 */
export async function updateElement(req, res) {
    const traceId = randomUUID();
    const start   = Date.now();

    try {
        const { id } = req.params;
        const patchData = req.body || {};

        if (patchData.element_type !== undefined || patchData.type !== undefined || patchData.elementType !== undefined) {
            return res.status(400).json({
                error: true,
                message: "Security Error: Element type is immutable and cannot be changed after creation."
            });
        }

        const updated = await elementRepository.update(id, patchData);

        const durationMs = Date.now() - start;
        console.log(JSON.stringify(structuredLog({ traceId, operation: "PATCH /api/v2/elements/:id", durationMs, status: "success" })));

        return res.json({ status: "success", element: updated });

    } catch (err) {
        const durationMs = Date.now() - start;
        const statusCode = err.statusCode || 500;
        console.error(JSON.stringify(structuredLog({ traceId, operation: "PATCH /api/v2/elements/:id", durationMs, status: "error", errorCode: statusCode, message: err.message })));
        return res.status(statusCode).json({ error: true, message: err.message });
    }
}

// ─── POST /api/v2/elements/analyze ──────────────────────────────────────────

const analysisService = new ElementAnalysisService();

export async function analyzeElement(req, res) {
    const traceId = randomUUID();
    const start   = Date.now();

    try {
        const { projectId, workflowId, imageUrls = [], elementName, elementType } = req.body;

        const result = await analysisService.analyzeElement({
            projectId,
            workflowId,
            imageUrls,
            elementName: elementName || "Element",
            elementType: elementType || "object",
        });

        const durationMs = Date.now() - start;
        console.log(JSON.stringify(structuredLog({ traceId, operation: "POST /api/v2/elements/analyze", durationMs, status: "success" })));

        return res.json({ status: "success", ...result });

    } catch (err) {
        const durationMs = Date.now() - start;
        const statusCode = err.statusCode || 500;
        console.error(JSON.stringify(structuredLog({ traceId, operation: "POST /api/v2/elements/analyze", durationMs, status: "error", errorCode: statusCode, message: err.message })));
        return res.status(statusCode).json({ error: true, message: err.message });
    }
}

