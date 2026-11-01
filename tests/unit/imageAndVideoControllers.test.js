import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { generateImage } from "../../controllers/imageController.js";
import { generateVideo } from "../../controllers/videoController.js";
import { generationRequestService, db } from "../../src/container.js";
import { AppError } from "../../src/utils/AppError.js";

describe("imageController and videoController unit tests", () => {
    let originalRequestGeneration;
    let originalFindOwnedProject;

    beforeEach(() => {
        originalRequestGeneration = generationRequestService.requestGeneration;
        if (db.projects) {
            originalFindOwnedProject = db.projects.findOwnedProject;
            db.projects.findOwnedProject = async () => ({ id: "proj-123", user_id: "user-1" });
            db.projects.findByUser = async () => [{ id: "proj-123", user_id: "user-1" }];
        }
    });

    afterEach(() => {
        generationRequestService.requestGeneration = originalRequestGeneration;
        if (db.projects && originalFindOwnedProject) {
            db.projects.findOwnedProject = originalFindOwnedProject;
        }
    });

    describe("imageController.generateImage", () => {
        it("rejects direct image sources with HTTP 400", async () => {
            const req = {
                body: {
                    image_url: "http://example.com/direct.png",
                    prompt: "test",
                    project_id: "proj-123",
                    model: "nano-banana",
                },
                user: { id: "user-1" },
            };
            let statusCode = 200;
            let payload = null;
            const res = {
                status: (code) => {
                    statusCode = code;
                    return res;
                },
                json: (data) => {
                    payload = data;
                },
            };

            await generateImage(req, res);
            assert.equal(statusCode, 400);
            assert.match(payload.message, /Direct image sources are not permitted/);
        });

        it("delegates to generationRequestService with image configuration", async () => {
            let capturedArgs = null;
            generationRequestService.requestGeneration = async (args) => {
                capturedArgs = args;
                return {
                    ok: true,
                    status: "processing",
                    workflowId: "wf-img-1",
                    mediaId: "m-img-1",
                };
            };

            const req = {
                body: {
                    prompt: "A beautiful forest",
                    project_id: "proj-123",
                    model: "nano-banana",
                    parameters: { aspect_ratio: "16:9" },
                },
                user: { id: "user-1" },
            };
            let payload = null;
            const res = {
                json: (data) => {
                    payload = data;
                },
            };

            await generateImage(req, res);
            assert.ok(capturedArgs);
            assert.equal(capturedArgs.mediaType, "image");
            assert.equal(capturedArgs.stepId, "image_generation");
            assert.equal(capturedArgs.useCaseId, "image-generation-v1");
            assert.equal(payload.ok, true);
            assert.equal(payload.workflowId, "wf-img-1");
        });

        it("returns HTTP 503 when QUEUE_DISPATCH_FAILED error is thrown", async () => {
            generationRequestService.requestGeneration = async () => {
                const err = new AppError("Queue full", 503);
                err.code = "QUEUE_DISPATCH_FAILED";
                err.workflowId = "wf-err";
                err.mediaId = "m-err";
                err.mediaIds = ["m-err"];
                throw err;
            };

            const req = {
                body: {
                    prompt: "A beautiful forest",
                    project_id: "proj-123",
                    model: "nano-banana",
                },
                user: { id: "user-1" },
            };
            let statusCode = 200;
            let payload = null;
            const res = {
                status: (code) => {
                    statusCode = code;
                    return res;
                },
                json: (data) => {
                    payload = data;
                },
            };

            await generateImage(req, res);
            assert.equal(statusCode, 503);
            assert.equal(payload.code, "QUEUE_DISPATCH_FAILED");
        });
    });

    describe("videoController.generateVideo", () => {
        it("rejects direct video sources with HTTP 400", async () => {
            const req = {
                body: {
                    video_url: "http://example.com/video.mp4",
                    prompt: "test",
                    project_id: "proj-123",
                    model: "veo-2",
                },
                user: { id: "user-1" },
            };
            let statusCode = 200;
            let payload = null;
            const res = {
                status: (code) => {
                    statusCode = code;
                    return res;
                },
                json: (data) => {
                    payload = data;
                },
            };

            await generateVideo(req, res);
            assert.equal(statusCode, 400);
            assert.match(payload.message, /Direct media sources are not permitted/);
        });

        it("delegates to generationRequestService with video configuration and default 16:9 aspect ratio", async () => {
            let capturedArgs = null;
            generationRequestService.requestGeneration = async (args) => {
                capturedArgs = args;
                return {
                    ok: true,
                    status: "processing",
                    workflowId: "wf-vid-1",
                    mediaId: "m-vid-1",
                };
            };

            const req = {
                body: {
                    prompt: "A soaring eagle",
                    project_id: "proj-123",
                    model: "veo-2",
                },
                user: { id: "user-1" },
            };
            let payload = null;
            const res = {
                json: (data) => {
                    payload = data;
                },
            };

            await generateVideo(req, res);
            assert.ok(capturedArgs);
            assert.equal(capturedArgs.mediaType, "video");
            assert.equal(capturedArgs.stepId, "video_generation");
            assert.equal(capturedArgs.useCaseId, "video-generation-v1");
            assert.equal(capturedArgs.mediaMeta.aspect_ratio, "16:9");
            assert.equal(payload.ok, true);
            assert.equal(payload.workflowId, "wf-vid-1");
        });
    });
});
