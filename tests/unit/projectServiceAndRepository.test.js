import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProjectService } from "../../src/domain/project/ProjectService.js";
import { ProjectReadService } from "../../src/domain/project/ProjectReadService.js";

describe("Slice B: ProjectService & Repository isolation", () => {
    it("ProjectService.listUserProjects delegates to projectRepo and maps name/thumbnail", async () => {
        const mockProjects = [
            { id: "p1", project_name: "Project One", user_id: "u1", media: [{ url: "https://cdn.example.com/thumb.png" }] },
            { id: "p2", project_name: "Project Two", user_id: "u1", media: [] },
        ];
        const mockRepo = {
            findProjectsWithThumbnails: async (userId) => {
                assert.equal(userId, "u1");
                return mockProjects;
            },
        };
        const service = new ProjectService({ projectRepo: mockRepo });
        const result = await service.listUserProjects("u1");

        assert.equal(result.length, 2);
        assert.equal(result[0].name, "Project One");
        assert.equal(result[0].thumbnail_url, "https://cdn.example.com/thumb.png");
        assert.equal(result[1].name, "Project Two");
        assert.equal(result[1].thumbnail_url, null);
    });

    it("ProjectService.createProject generates default name if none supplied and inserts via repo", async () => {
        let insertedPayload = null;
        const mockRepo = {
            insertProject: async ({ projectName, userId }) => {
                insertedPayload = { projectName, userId };
                return { id: "p-new", project_name: projectName, user_id: userId };
            },
        };
        const service = new ProjectService({ projectRepo: mockRepo });
        const result = await service.createProject({ userId: "u1" });

        assert.ok(insertedPayload);
        assert.equal(insertedPayload.userId, "u1");
        assert.ok(insertedPayload.projectName.length > 0);
        assert.equal(result.name, insertedPayload.projectName);
    });

    it("ProjectService.updateProject enforces ownership and throws 404 for foreign access", async () => {
        const mockRepo = {
            findOwnedProject: async (id, userId) => null, // foreign or missing
            updateProjectName: async () => assert.fail("Should not reach update"),
        };
        const service = new ProjectService({ projectRepo: mockRepo });

        await assert.rejects(
            async () => service.updateProject({ id: "p-foreign", userId: "u1", name: "Hacked" }),
            (err) => {
                assert.equal(err.statusCode, 404);
                assert.match(err.message, /not found/i);
                return true;
            }
        );
    });

    it("ProjectService.deleteProject enforces ownership and throws 404 for foreign access", async () => {
        const mockRepo = {
            findOwnedProject: async (id, userId) => null,
            deleteOwnedProject: async () => assert.fail("Should not reach delete"),
        };
        const service = new ProjectService({ projectRepo: mockRepo });

        await assert.rejects(
            async () => service.deleteProject({ id: "p-foreign", userId: "u1" }),
            (err) => {
                assert.equal(err.statusCode, 404);
                assert.match(err.message, /not found/i);
                return true;
            }
        );
    });

    it("ProjectReadService.getProjectData queries strictly through injected db repositories", async () => {
        let queriedProjects = false;
        let queriedMedia = false;
        let queriedElements = false;
        let queriedCharacters = false;
        let queriedWorkflowMedia = false;

        const mockDb = {
            projects: {
                findById: async (id) => {
                    queriedProjects = true;
                    return { id, project_name: "Repo Clean Project", user_id: "user-1" };
                },
            },
            workflows: {
                findByProject: async () => [
                    { id: "wf-1", display_name: "Workflow 1", create_time: "2026-01-01T00:00:00Z", workflow_type: "GENERATION" },
                ],
            },
            media: {
                findByProjectAll: async (projectId) => {
                    queriedMedia = true;
                    return [];
                },
            },
            elements: {
                findByWorkflowIds: async (ids) => {
                    queriedElements = true;
                    return [];
                },
            },
            characters: {
                findByProjectOrWorkflowIds: async ({ projectId, workflowIds }) => {
                    queriedCharacters = true;
                    return [];
                },
            },
            workflowMedia: {
                findRelationsByWorkflowIds: async (ids) => {
                    queriedWorkflowMedia = true;
                    return [];
                },
            },
        };

        const readService = new ProjectReadService({ db: mockDb });
        const data = await readService.getProjectData({ projectId: "proj-1", userId: "user-1" });

        assert.ok(queriedProjects, "Must query projects repository");
        assert.ok(queriedMedia, "Must query media repository");
        assert.ok(queriedElements, "Must query elements repository");
        assert.ok(queriedCharacters, "Must query characters repository");
        assert.ok(queriedWorkflowMedia, "Must query workflowMedia repository");
        assert.equal(data.projectName, "Repo Clean Project");
    });
});
