import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
    getElementPromptContext,
    validateElementsExist,
    elementRepository,
    ElementRepository,
    ElementService,
    ElementMediaService,
    ElementAnalysisService,
    extractElementTokens,
    stripElementTokens,
    PromptBuilderProService,
    getElementContextForPrompt,
    ElementsError,
    ElementsValidationError,
    ElementsNotFoundError,
    ElementsConflictError,
    ElementsUnauthorizedError,
} from "#elements/tools";

import elementsRouter from "#elements/api";

describe("System 7: Elements (#elements/tools & #elements/api)", () => {
    describe("1. Exported Error Hierarchy", () => {
        it("ElementsError inherits from AppError with 500 status", () => {
            const err = new ElementsError("ELEM_ERR", "Elements system failure");
            assert.equal(err.statusCode, 500);
            assert.equal(err.code, "ELEM_ERR");
        });

        it("ElementsValidationError sets 400 status and field context", () => {
            const err = new ElementsValidationError("Invalid elementId", { field: "elementId" });
            assert.equal(err.statusCode, 400);
            assert.equal(err.field, "elementId");
        });

        it("ElementsNotFoundError sets 404 status and elementId context", () => {
            const err = new ElementsNotFoundError("Element not found", { elementId: "elem-123" });
            assert.equal(err.statusCode, 404);
            assert.equal(err.elementId, "elem-123");
        });

        it("ElementsConflictError sets 409 status", () => {
            const err = new ElementsConflictError("Element quota exceeded");
            assert.equal(err.statusCode, 409);
        });

        it("ElementsUnauthorizedError sets 403 status", () => {
            const err = new ElementsUnauthorizedError("Access denied", { elementId: "elem-123", userId: "user-456" });
            assert.equal(err.statusCode, 403);
        });
    });

    describe("2. Tools Interface (#elements/tools)", () => {
        it("getElementPromptContext returns empty context when elementIds is empty", async () => {
            const res = await getElementPromptContext({ elementIds: [] });
            assert.deepEqual(res, {
                elements: [],
                referenceMediaUrls: [],
            });
        });

        it("getElementPromptContext throws ElementsNotFoundError when an element is missing", async () => {
            const origResolve = elementRepository.resolveRecord;
            elementRepository.resolveRecord = async () => null;

            try {
                await assert.rejects(
                    async () => getElementPromptContext({ elementIds: ["missing-elem-uuid"] }),
                    (err) => err instanceof ElementsNotFoundError && err.statusCode === 404
                );
            } finally {
                elementRepository.resolveRecord = origResolve;
            }
        });

        it("getElementPromptContext returns aggregated traits and reference URLs", async () => {
            const mockRecord1 = {
                id: "elem-1",
                workflow_id: "wf-1",
                name: "Cyber Katana",
                description: "A neon blade emitting high-frequency plasma.",
                guidelines: "Keep blade blue and hilt carbon fiber.",
                reference_images: ["https://cdn.art/blade1.png", "https://cdn.art/blade2.png"],
            };

            const origResolve = elementRepository.resolveRecord;
            elementRepository.resolveRecord = async (id) => (id === "elem-1" ? mockRecord1 : null);

            try {
                const res = await getElementPromptContext({ elementIds: ["elem-1"] });
                assert.equal(res.elements.length, 1);
                assert.equal(res.elements[0].name, "Cyber Katana");
                assert.equal(res.elements[0].guidelines, "Keep blade blue and hilt carbon fiber.");
                assert.deepEqual(res.referenceMediaUrls, [
                    "https://cdn.art/blade1.png",
                    "https://cdn.art/blade2.png",
                ]);
            } finally {
                elementRepository.resolveRecord = origResolve;
            }
        });

        it("validateElementsExist throws ElementsValidationError if elementIds is empty", async () => {
            await assert.rejects(
                async () => validateElementsExist({ elementIds: [] }),
                (err) => err instanceof ElementsValidationError && err.statusCode === 400
            );
        });

        it("validateElementsExist returns true when all elements exist", async () => {
            const origResolve = elementRepository.resolveRecord;
            elementRepository.resolveRecord = async (id) => ({ id });

            try {
                const valid = await validateElementsExist({ elementIds: ["elem-1", "elem-2"] });
                assert.equal(valid, true);
            } finally {
                elementRepository.resolveRecord = origResolve;
            }
        });

        it("exports element services, token extractors, and repository", () => {
            assert.ok(ElementService);
            assert.ok(ElementMediaService);
            assert.ok(ElementAnalysisService);
            assert.ok(ElementRepository);
            assert.ok(elementRepository);
            assert.equal(typeof extractElementTokens, "function");
            assert.equal(typeof stripElementTokens, "function");
            assert.ok(PromptBuilderProService);
            assert.equal(typeof getElementContextForPrompt, "function");
        });
    });

    describe("3. HTTP API Gateway (#elements/api)", () => {
        it("exports an Express router with all element endpoints", () => {
            assert.ok(elementsRouter);
            assert.ok(Array.isArray(elementsRouter.stack));

            const routes = elementsRouter.stack
                .filter((layer) => layer.route)
                .map((layer) => ({
                    path: layer.route.path,
                    methods: Object.keys(layer.route.methods),
                }));

            const paths = routes.map((r) => r.path);
            assert.ok(paths.includes("/"));
            assert.ok(paths.includes("/analyze"));
            assert.ok(paths.includes("/project/:projectId"));
            assert.ok(paths.includes("/build-prompt"));
            assert.ok(paths.includes("/:id/images"));
            assert.ok(paths.includes("/:id/images/:mediaId"));
            assert.ok(paths.includes("/:id"));
        });
    });
});
