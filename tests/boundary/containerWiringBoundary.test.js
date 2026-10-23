import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as container from "../../src/container.js";
import { WorkflowMediaService } from "../../src/platform/workflow/WorkflowMediaService.js";
import { MediaUploadService } from "../../src/platform/media-ingestion/MediaUploadService.js";
import { WorkflowLifecycleService } from "../../src/platform/workflow/WorkflowService.js";
import { WorkflowService as WorkflowServiceBase } from "../../src/platform/workflow/WorkflowServiceBase.js";

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

        // 5. ElementMediaService -> workflowService -> mediaService
        assert.ok(container.elementMediaService, "container.elementMediaService must be instantiated");
        assert.ok(container.elementMediaService.workflowService, "elementMediaService must receive workflowService");
        assert.equal(
            container.elementMediaService.workflowService.mediaService.mediaUploadService,
            rootUploadService,
            "elementMediaService.workflowService.mediaService must hold root mediaUploadService"
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
});
