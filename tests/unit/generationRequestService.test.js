import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { GenerationRequestService } from "#generation/tools";
import { AppError } from "#shared";

describe("GenerationRequestService unit tests", () => {
    it("successfully creates workflow, media placeholders, and dispatches to useCaseService", async () => {
        const createdWorkflows = [];
        const createdMedia = [];
        const linkedWorkflows = [];
        let enqueuedPayload = null;

        const mockDb = {
            workflows: {
                createWorkflow: async (wf) => {
                    createdWorkflows.push(wf);
                    return wf;
                },
            },
            media: {
                createMedia: async (m) => {
                    createdMedia.push(m);
                    return m;
                },
                updateMedia: async () => {},
            },
            workflowMedia: {
                linkMedia: async (link) => {
                    linkedWorkflows.push(link);
                },
            },
        };

        const mockUseCaseService = {
            prepareAndEnqueue: async (args) => {
                enqueuedPayload = args;
                return {
                    jobId: "job-img-999",
                    executionId: args.executionId,
                    cost: { totalCredits: 5 },
                };
            },
        };

        const mockFolderService = {
            validateAndAssertUsable: async (folderId) => folderId,
        };

        const service = new GenerationRequestService({
            db: mockDb,
            useCaseService: mockUseCaseService,
            folderService: mockFolderService,
        });

        const result = await service.requestGeneration({
            userId: "user-1",
            mediaType: "image",
            stepId: "image_generation",
            useCaseId: "image-generation-v1",
            prompt: "A beautiful cinematic landscape",
            model: "nanobana_pro",
            projectId: "proj-123",
            folderId: "folder-abc",
            references: ["wf-ref-1"],
            parameters: { aspect_ratio: "16:9" },
            mediaMeta: { width: 1920, height: 1080, aspect_ratio: "16:9" },
            outputCount: 1,
            defaultMessages: {
                started: "Image generation started.",
                addCredits: "Add credits to generate your image.",
            },
        });

        assert.equal(result.ok, true);
        assert.equal(result.status, "processing");
        assert.equal(result.needsCredits, false);
        assert.equal(result.cost, 5);
        assert.equal(result.taskId, "job-img-999");
        assert.equal(createdWorkflows.length, 1);
        assert.equal(createdWorkflows[0].display_name, "A beautiful cinematic landscape");
        assert.equal(createdWorkflows[0].folder_id, "folder-abc");
        assert.equal(createdMedia.length, 1);
        assert.equal(createdMedia[0].step_id, "image_generation");
        assert.equal(enqueuedPayload.useCaseId, "image-generation-v1");
        assert.equal(enqueuedPayload.userId, "user-1");
    });

    it("handles INSUFFICIENT_CREDITS gracefully without throwing, marking media as saved", async () => {
        const updatedMedia = [];
        const mockDb = {
            workflows: {
                createWorkflow: async (wf) => wf,
            },
            media: {
                createMedia: async (m) => m,
                updateMedia: async (id, patch) => {
                    updatedMedia.push({ id, ...patch });
                },
            },
            workflowMedia: {
                linkMedia: async () => {},
            },
        };

        const mockUseCaseService = {
            prepareAndEnqueue: async () => {
                const err = new Error("User does not have enough credits");
                err.code = "INSUFFICIENT_CREDITS";
                throw err;
            },
        };

        const mockFolderService = {
            validateAndAssertUsable: async () => null,
        };

        const service = new GenerationRequestService({
            db: mockDb,
            useCaseService: mockUseCaseService,
            folderService: mockFolderService,
        });

        const result = await service.requestGeneration({
            userId: "user-1",
            mediaType: "video",
            stepId: "video_generation",
            useCaseId: "video-generation-v1",
            prompt: "A cinematic slow motion scene",
            model: "seedance_2_5",
            projectId: "proj-123",
            folderId: null,
            references: [],
            parameters: {},
            mediaMeta: { width: 1920, height: 1080, aspect_ratio: "16:9" },
            outputCount: 1,
            defaultMessages: {
                started: "Video generation started.",
                addCredits: "Add credits to generate your video.",
            },
        });

        assert.equal(result.ok, true);
        assert.equal(result.status, "saved");
        assert.equal(result.needsCredits, true);
        assert.equal(result.message, "User does not have enough credits");
        assert.equal(updatedMedia.length, 1);
        assert.equal(updatedMedia[0].status, "saved");
    });

    it("handles QUEUE_DISPATCH_FAILED by marking media as failed and throwing 503 error", async () => {
        const updatedMedia = [];
        const mockDb = {
            workflows: {
                createWorkflow: async (wf) => wf,
            },
            media: {
                createMedia: async (m) => m,
                updateMedia: async (id, patch) => {
                    updatedMedia.push({ id, ...patch });
                },
            },
            workflowMedia: {
                linkMedia: async () => {},
            },
        };

        const mockUseCaseService = {
            prepareAndEnqueue: async () => {
                const err = new Error("Redis cluster unreachable");
                err.code = "QUEUE_DISPATCH_FAILED";
                throw err;
            },
        };

        const mockFolderService = {
            validateAndAssertUsable: async () => null,
        };

        const service = new GenerationRequestService({
            db: mockDb,
            useCaseService: mockUseCaseService,
            folderService: mockFolderService,
        });

        await assert.rejects(
            async () => {
                await service.requestGeneration({
                    userId: "user-1",
                    mediaType: "image",
                    stepId: "image_generation",
                    useCaseId: "image-generation-v1",
                    prompt: "A neon cityscape",
                    model: "nanobana_pro",
                    projectId: "proj-123",
                    folderId: null,
                    references: [],
                    parameters: {},
                    mediaMeta: { width: 1024, height: 1024, aspect_ratio: "1:1" },
                    outputCount: 1,
                });
            },
            (err) => {
                assert.equal(err.statusCode, 503);
                assert.equal(err.code, "QUEUE_DISPATCH_FAILED");
                assert.equal(updatedMedia.length, 1);
                assert.equal(updatedMedia[0].status, "failed");
                return true;
            }
        );
    });
});
