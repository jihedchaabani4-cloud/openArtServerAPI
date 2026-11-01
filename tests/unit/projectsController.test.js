import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getAll, create, update, remove } from "../../controllers/projectsController.js";
import { projectService } from "../../src/container.js";
import { AppError } from "../../src/utils/AppError.js";

describe("projectsController unit tests", () => {
    let originalListUserProjects;
    let originalCreateProject;
    let originalUpdateProject;
    let originalDeleteProject;

    beforeEach(() => {
        originalListUserProjects = projectService.listUserProjects;
        originalCreateProject = projectService.createProject;
        originalUpdateProject = projectService.updateProject;
        originalDeleteProject = projectService.deleteProject;
    });

    afterEach(() => {
        projectService.listUserProjects = originalListUserProjects;
        projectService.createProject = originalCreateProject;
        projectService.updateProject = originalUpdateProject;
        projectService.deleteProject = originalDeleteProject;
    });

    it("getAll calls projectService.listUserProjects and returns data", async () => {
        projectService.listUserProjects = async (userId) => [
            { id: "p1", name: "P1", thumbnail_url: "http://example.com/1.png" },
        ];

        const req = { user: { id: "user-abc" } };
        let sent = null;
        const res = {
            json: (payload) => {
                sent = payload;
            },
        };

        await getAll(req, res);
        assert.deepEqual(sent, {
            ok: true,
            data: [{ id: "p1", name: "P1", thumbnail_url: "http://example.com/1.png" }],
        });
    });

    it("create passes name and userId to projectService.createProject", async () => {
        let calledWith = null;
        projectService.createProject = async (args) => {
            calledWith = args;
            return { id: "new-p", name: args.name, user_id: args.userId };
        };

        const req = { user: { id: "user-abc" }, body: { name: "My New Canvas" } };
        let sent = null;
        const res = {
            json: (payload) => {
                sent = payload;
            },
        };

        await create(req, res);
        assert.deepEqual(calledWith, { userId: "user-abc", name: "My New Canvas" });
        assert.equal(sent.ok, true);
        assert.equal(sent.data.id, "new-p");
    });

    it("update returns 404 when projectService throws AppError(404)", async () => {
        projectService.updateProject = async () => {
            throw new AppError("Project not found", 404);
        };

        const req = { params: { id: "p-other" }, user: { id: "user-abc" }, body: { name: "Renamed" } };
        let statusCode = 200;
        let sent = null;
        const res = {
            status: (code) => {
                statusCode = code;
                return res;
            },
            json: (payload) => {
                sent = payload;
            },
        };

        await update(req, res);
        assert.equal(statusCode, 404);
        assert.equal(sent.ok, false);
        assert.equal(sent.message, "Project not found");
    });

    it("remove returns 200 on success", async () => {
        let deletedId = null;
        projectService.deleteProject = async ({ id }) => {
            deletedId = id;
            return true;
        };

        const req = { params: { id: "p-del" }, user: { id: "user-abc" } };
        let sent = null;
        const res = {
            json: (payload) => {
                sent = payload;
            },
        };

        await remove(req, res);
        assert.equal(deletedId, "p-del");
        assert.deepEqual(sent, { ok: true });
    });
});
