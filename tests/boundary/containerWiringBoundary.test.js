import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as container from "../../src/container.js";
import { WorkflowMediaService } from "#generation/tools";
import { MediaUploadService } from "#media/tools";
import { MediaService, MediaWorkflowLifecycleService } from "#media/tools";
import { WorkflowLifecycleService } from "#generation/tools";
import { WorkflowService as WorkflowServiceBase } from "#generation/tools";
import { ElementService } from "#elements/tools";
import { ElementMediaService } from "#elements/tools";
import { CharacterService } from "#characters/tools";
import { CharacterMediaService } from "#characters/tools";
import { TrashRepository } from "#workspace/tools";
import { TrashService } from "#workspace/tools";

describe("Container Service Graph & Dependency Wiring Boundary", () => {
    it("asserts that every WorkflowMediaService reachable from the container holds the exact same mediaUploadService instance", () => {
        // 1. Root MediaUploadService exists in container
        assert.ok(container.mediaUploadService, "container.mediaUploadService must be instantiated");
        assert.ok(container.mediaUploadService instanceof MediaUploadService, "must be instance of MediaUploadService");
        assert.equal(typeof container.mediaUploadService.discard, "function", "must expose discard method");

        const rootUploadService = container.mediaUploadService;

        // 2. WorkflowLifecycleService (subclass of WorkflowServiceBase) and its WorkflowMediaService
        assert.ok(container.workflowService instanceof WorkflowLifecycleService, "workflowService must be WorkflowLifecycleService");
        assert.ok(container.workflowService instanceof WorkflowServiceBase, "workflowService must inherit WorkflowServiceBase");
        assert.ok(container.workflowService.mediaService instanceof WorkflowMediaService, "workflowService.mediaService must be WorkflowMediaService");
        assert.equal(
            container.workflowService.mediaService.mediaUploadService,
            rootUploadService,
            "workflowService.mediaService must hold the container's mediaUploadService instance"
        );
        assert.ok(container.workflowService.authService, "workflowService must have authService");
        assert.equal(
            container.workflowService.mediaService.authService,
            container.workflowService.authService,
            "workflowService.mediaService must hold workflowService.authService"
        );
        assert.equal(
            typeof container.workflowService.mediaService.authService.verifyWorkflowOwnership,
            "function",
            "authService must provide verifyWorkflowOwnership"
        );

        // 3. Container exported workflowMediaService alias
        assert.equal(
            container.workflowMediaService,
            container.workflowService.mediaService,
            "container.workflowMediaService must be the exact instance on workflowService.mediaService"
        );
        assert.equal(
            container.workflowMediaService.mediaUploadService,
            rootUploadService,
            "container.workflowMediaService must hold root mediaUploadService"
        );
        assert.equal(
            container.workflowMediaService.authService,
            container.workflowService.authService,
            "container.workflowMediaService must hold workflowService.authService"
        );

        // 4. AssetUploadService and its attached WorkflowMediaService
        assert.ok(container.assetUploadService, "container.assetUploadService must be instantiated");
        assert.equal(
            container.assetUploadService.mediaUploadService,
            rootUploadService,
            "assetUploadService.mediaUploadService must hold root mediaUploadService"
        );
        assert.ok(
            container.assetUploadService.workflowMediaService instanceof WorkflowMediaService,
            "assetUploadService.workflowMediaService must be instance of WorkflowMediaService"
        );
        assert.equal(
            container.assetUploadService.workflowMediaService.mediaUploadService,
            rootUploadService,
            "assetUploadService.workflowMediaService must hold root mediaUploadService"
        );

        // 5. ElementMediaService: direct wiring to root upload, attach seam, and auth services
        assert.ok(container.elementMediaService, "container.elementMediaService must be instantiated");
        assert.equal(
            container.elementMediaService.mediaUploadService,
            rootUploadService,
            "elementMediaService.mediaUploadService must hold root mediaUploadService"
        );
        assert.equal(
            container.elementMediaService.workflowMediaService,
            container.workflowMediaService,
            "elementMediaService.workflowMediaService must hold container workflowMediaService"
        );
        assert.equal(
            container.elementMediaService.authService,
            container.workflowService.authService,
            "elementMediaService.authService must hold container authService"
        );
        assert.equal(
            container.elementMediaService.mediaIngestionService,
            undefined,
            "elementMediaService.mediaIngestionService must be removed"
        );
        assert.equal(
            container.elementMediaService.workflowService,
            undefined,
            "elementMediaService.workflowService must be removed"
        );

        // 6. CharacterService -> workflowService -> mediaService
        assert.ok(container.characterService, "container.characterService must be instantiated");
        assert.ok(container.characterService.workflowService, "characterService must receive workflowService");
        assert.equal(
            container.characterService.workflowService.mediaService.mediaUploadService,
            rootUploadService,
            "characterService.workflowService.mediaService must hold root mediaUploadService"
        );
    });

    it("behavioral wiring: attachMediaItems failure triggers storageKey discard on shared mediaUploadService through the real container service graph", async () => {
        const deletedPaths = [];
        const originalDeleteFiles = container.storageService.deleteFiles;
        const originalUpload = container.storageService.upload;
        const originalProviderDeleteFiles = container.storageService.provider?.deleteFiles;

        const originalDbProjectsFindById = container.db.projects.findById;
        const originalDbProjectsFindByUser = container.db.projects.findByUser;
        const originalDbWorkflowsCreate = container.db.workflows.createWorkflow;
        const originalDbWorkflowsDeleteById = container.db.workflows.deleteById;
        const originalDbWorkflowsFindById = container.db.workflows.findById;
        const originalDbWorkflowsGetWorkflow = container.db.workflows.getWorkflow;
        const originalDbMediaCreate = container.db.media.createMedia;
        const originalVerifyWorkflowOwnership = container.workflowMediaService.authService.verifyWorkflowOwnership;

        const VALID_PNG_BUFFER = Buffer.from(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            "base64"
        );

        try {
            container.storageService.upload = async (path) => `https://mock.storage/${path}`;
            container.storageService.deleteFiles = async (paths) => {
                deletedPaths.push(...paths);
                return { deletedCount: paths.length, failures: [] };
            };
            if (container.storageService.provider) {
                container.storageService.provider.deleteFiles = async (paths) => {
                    deletedPaths.push(...paths);
                    return { data: paths.map((p) => ({ name: p })), error: null };
                };
            }

            const mockWf = {
                id: "wf-wiring-new",
                user_id: "user-wiring-1",
                project_id: "proj-wiring-1",
                workflow_type: "UPLOAD",
            };
            container.db.projects.findById = async (id) => ({ id, user_id: "user-wiring-1" });
            container.db.projects.findByUser = async (uid, pid) => [{ id: pid, user_id: uid }];
            container.db.workflows.createWorkflow = async (data) => ({ ...mockWf, ...data });
            container.db.workflows.findById = async () => mockWf;
            container.db.workflows.getWorkflow = async () => mockWf;
            container.db.workflows.deleteById = async () => ({ deleted: true });
            container.workflowMediaService.authService.verifyWorkflowOwnership = async (id, uid) => (uid === "user-wiring-1");

            // Simulate failure inside attachMediaItems (e.g. media insert failure or attach RPC failure)
            container.db.media.createMedia = async () => {
                throw new Error("Simulated DB failure during attach");
            };

            await assert.rejects(
                () => container.assetUploadService.uploadAsset({
                    source: { buffer: VALID_PNG_BUFFER, originalName: "test-wiring-file.png" },
                    userId: "user-wiring-1",
                    projectId: "proj-wiring-1",
                }),
                /Simulated DB failure during attach/
            );

            assert.ok(deletedPaths.length > 0, "storageService.deleteFiles must have received discarded storage keys");
            assert.ok(
                deletedPaths.some((p) => p.includes("user-wiring-1/uploads/")),
                `discarded paths must include uploaded user key, got: ${JSON.stringify(deletedPaths)}`
            );
        } finally {
            container.storageService.deleteFiles = originalDeleteFiles;
            container.storageService.upload = originalUpload;
            if (container.storageService.provider) {
                container.storageService.provider.deleteFiles = originalProviderDeleteFiles;
            }
            container.db.projects.findById = originalDbProjectsFindById;
            container.db.projects.findByUser = originalDbProjectsFindByUser;
            container.db.workflows.createWorkflow = originalDbWorkflowsCreate;
            container.db.workflows.findById = originalDbWorkflowsFindById;
            container.db.workflows.getWorkflow = originalDbWorkflowsGetWorkflow;
            container.db.workflows.deleteById = originalDbWorkflowsDeleteById;
            container.db.media.createMedia = originalDbMediaCreate;
            container.workflowMediaService.authService.verifyWorkflowOwnership = originalVerifyWorkflowOwnership;
        }
    });

    it("ElementService wiring: elementMediaService is REQUIRED and holds container.elementMediaService instance", () => {
        assert.ok(container.elementService, "container.elementService must exist");
        assert.equal(
            container.elementService.mediaService,
            container.elementMediaService,
            "container.elementService.mediaService must hold container.elementMediaService"
        );
        assert.equal(
            container.elementService.workflowService,
            container.workflowService,
            "container.elementService.workflowService must hold container.workflowService"
        );
        assert.throws(
            () => new ElementService({ db: {} }),
            (err) => err.message.includes("ElementService requires mediaService"),
            "ElementService constructor must throw if mediaService is missing"
        );
        assert.strictEqual(
            container.elementService.mediaIngestionService,
            undefined,
            "container.elementService.mediaIngestionService must be removed"
        );
        assert.throws(
            () => new ElementMediaService({
                storageService: {},
                mediaUploadService: { upload: () => {} },
                workflowMediaService: { attachMediaItems: () => {} },
                authService: { verifyWorkflowOwnership: () => {} },
            }),
            (err) => err.message.includes("ElementMediaService requires db"),
            "ElementMediaService constructor must throw if db is missing"
        );
    });

    it("CharacterService & CharacterMediaService wiring: characterMediaService is REQUIRED and holds container singletons", () => {
        assert.ok(container.characterMediaService, "container.characterMediaService must exist");
        assert.ok(
            container.characterMediaService instanceof CharacterMediaService,
            "container.characterMediaService must be instance of CharacterMediaService"
        );
        assert.equal(
            container.characterMediaService.mediaUploadService,
            container.mediaUploadService,
            "characterMediaService.mediaUploadService must hold container mediaUploadService"
        );
        assert.equal(
            container.characterMediaService.workflowMediaService,
            container.workflowMediaService,
            "characterMediaService.workflowMediaService must hold container workflowMediaService"
        );
        assert.equal(
            container.characterMediaService.authService,
            container.workflowService.authService,
            "characterMediaService.authService must hold container authService"
        );

        assert.ok(container.characterService, "container.characterService must exist");
        assert.equal(
            container.characterService.mediaService,
            container.characterMediaService,
            "container.characterService.mediaService must hold container.characterMediaService"
        );
        assert.equal(
            container.characterService.workflowService,
            container.workflowService,
            "container.characterService.workflowService must hold container.workflowService"
        );
        assert.throws(
            () => new CharacterService({ db: {} }),
            (err) => err.message.includes("CharacterService requires mediaService"),
            "CharacterService constructor must throw if mediaService is missing"
        );
        assert.throws(
            () => new CharacterMediaService({ db: {} }),
            (err) => err.message.includes("CharacterMediaService requires storageService"),
            "CharacterMediaService constructor must throw if required dependencies are missing"
        );
    });

    it("TrashService & TrashRepository wiring: container exposes db.trash and trashService with shared domain services and zero circular references", () => {
        assert.ok(container.db.trash instanceof TrashRepository, "container.db.trash must be instance of TrashRepository");
        assert.ok(container.trashService instanceof TrashService, "container.trashService must be instance of TrashService");
        assert.equal(container.trashService.db, container.db, "trashService.db must hold container.db");
        assert.equal(
            container.trashService.workflowService,
            container.workflowService,
            "trashService.workflowService must hold container.workflowService"
        );
        assert.equal(
            container.trashService.elementService,
            container.elementService,
            "trashService.elementService must hold container.elementService"
        );
        assert.equal(
            container.trashService.characterService,
            container.characterService,
            "trashService.characterService must hold container.characterService"
        );
        assert.equal(container.workflowService.trashService, undefined, "workflowService must not depend on trashService");
        assert.equal(container.elementService.trashService, undefined, "elementService must not depend on trashService");
        assert.equal(container.characterService.trashService, undefined, "characterService must not depend on trashService");
    });

    it("Media platform wiring: container exposes MediaService & MediaWorkflowLifecycleService and drops legacy ingestion shims", () => {
        assert.ok(container.mediaService instanceof MediaService, "container.mediaService must be instance of MediaService");
        assert.equal(container.mediaService.mediaRepo, container.db.media, "mediaService.mediaRepo must hold container.db.media");
        assert.ok(
            container.mediaWorkflowLifecycleService instanceof MediaWorkflowLifecycleService,
            "container.mediaWorkflowLifecycleService must be instance of MediaWorkflowLifecycleService"
        );
        assert.equal("binaryIngestionService" in container, false, "container.binaryIngestionService must be removed");
        assert.equal("mediaIngestionService" in container, false, "container.mediaIngestionService must be removed");
        assert.equal("legacyMediaIngestAdapter" in container, false, "container.legacyMediaIngestAdapter must be removed");
        assert.strictEqual(
            container.characterService.mediaIngestionService,
            undefined,
            "container.characterService.mediaIngestionService must be removed"
        );
        assert.strictEqual(
            container.assetUploadService.binaryIngestionService,
            undefined,
            "container.assetUploadService.binaryIngestionService must be removed"
        );
    });
});
