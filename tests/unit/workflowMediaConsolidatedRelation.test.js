import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { WorkflowMediaRepository } from "#media/tools";
import { WorkflowRepository } from "#generation/tools";
import { WorkflowMediaService } from "#generation/tools";
import { ProjectReadService } from "#workspace/tools";
import { V1StorageBridge } from "#generation/tools";
import { supabase, supabaseAdmin } from "#shared/db/supabase.js";

describe("ADR-0007: Consolidated workflow_media Relation and Schema Pruning", () => {
    beforeEach(() => {
        WorkflowMediaRepository.clearMemory();
        WorkflowMediaRepository.enableTestMemoryFallback();
    });

    it("WorkflowMediaRepository: setPrimaryMedia sets is_primary = true on target and clears siblings", async () => {
        const repo = new WorkflowMediaRepository();
        await repo.linkMedia({ workflowId: "wf-1", mediaId: "m-1", role: "output" });
        await repo.linkMedia({ workflowId: "wf-1", mediaId: "m-2", role: "output" });

        const setRes = await repo.setPrimaryMedia({ workflowId: "wf-1", mediaId: "m-2" });
        assert.equal(setRes.is_primary, true);
        assert.equal(setRes.media_id, "m-2");

        const items = await repo.findByWorkflow("wf-1");
        const m1 = items.find((i) => i.id === "m-1" || i.media_id === "m-1");
        const m2 = items.find((i) => i.id === "m-2" || i.media_id === "m-2");

        assert.equal(m1.is_primary, false);
        assert.equal(m2.is_primary, true);

        // Switch primary to m-1
        await repo.setPrimaryMedia({ workflowId: "wf-1", mediaId: "m-1" });
        const itemsAfter = await repo.findByWorkflow("wf-1");
        const m1After = itemsAfter.find((i) => i.id === "m-1" || i.media_id === "m-1");
        const m2After = itemsAfter.find((i) => i.id === "m-2" || i.media_id === "m-2");

        assert.equal(m1After.is_primary, true);
        assert.equal(m2After.is_primary, false);
    });

    it("WorkflowMediaRepository: clearPrimaryMedia resets is_primary without auto-promoting another link", async () => {
        const repo = new WorkflowMediaRepository();
        await repo.linkMedia({ workflowId: "wf-1", mediaId: "m-1", role: "output" });
        await repo.setPrimaryMedia({ workflowId: "wf-1", mediaId: "m-1" });

        await repo.clearPrimaryMedia({ workflowId: "wf-1" });
        const items = await repo.findByWorkflow("wf-1");
        const m1 = items.find((i) => i.id === "m-1" || i.media_id === "m-1");

        assert.equal(m1.is_primary, false);
    });

    it("WorkflowMediaRepository: supports metadata column on workflow_media", async () => {
        const repo = new WorkflowMediaRepository();
        await repo.linkMedia({
            workflowId: "wf-1",
            mediaId: "m-meta",
            role: "output",
            metadata: { canvas_position: { x: 100, y: 200 } },
        });

        const items = await repo.findByWorkflow("wf-1");
        assert.deepEqual(items[0].metadata, { canvas_position: { x: 100, y: 200 } });
    });

    it("ProjectReadService: derives primary_media_id dynamically from workflow_media.is_primary", async () => {
        const projectId = "11111111-1111-4111-8111-111111111111";
        const userId = "22222222-2222-4222-8222-222222222222";
        const targetMediaId = "m-primary-dynamic";
        const targetWorkflowId = "wf-dynamic";

        const origFrom = supabase.from;
        const origAdminFrom = supabaseAdmin.from;

        supabase.from = (table) => {
            if (table === "project") {
                return {
                    select: () => ({
                        eq: () => ({
                            single: async () => ({
                                data: { id: projectId, user_id: userId, project_name: "Test Project" },
                                error: null,
                            }),
                        }),
                    }),
                };
            }
            if (table === "media") {
                return {
                    select: () => ({
                        eq: () => ({
                            order: async () => ({
                                data: [
                                    {
                                        id: targetMediaId,
                                        project_id: projectId,
                                        status: "success",
                                        url: "https://example.com/dynamic.jpg",
                                        width: 1024,
                                        height: 1024,
                                        step_id: "GEN",
                                        create_time: new Date().toISOString(),
                                    },
                                ],
                                error: null,
                            }),
                        }),
                    }),
                };
            }
            if (table === "workflow_media") {
                return {
                    select: () => ({
                        in: async () => ({
                            data: [
                                {
                                    workflow_id: targetWorkflowId,
                                    media_id: targetMediaId,
                                    role: "output",
                                    is_primary: true,
                                    metadata: {},
                                    created_at: new Date().toISOString(),
                                },
                            ],
                            error: null,
                        }),
                    }),
                };
            }
            if (table === "element" || table === "characters") {
                return {
                    select: () => ({
                        in: async () => ({ data: [], error: null }),
                        eq: async () => ({ data: [], error: null }),
                        or: async () => ({ data: [], error: null }),
                    }),
                };
            }
            return origFrom.call(supabase, table);
        };

        supabaseAdmin.from = (table) => {
            if (table === "characters") {
                return {
                    select: () => ({
                        or: async () => ({ data: [], error: null }),
                        eq: async () => ({ data: [], error: null }),
                    }),
                };
            }
            return origAdminFrom.call(supabaseAdmin, table);
        };

        try {
            const mockDb = {
                workflows: {
                    findByProject: async (pid) => [
                        {
                            id: targetWorkflowId,
                            project_id: pid,
                            display_name: "Dynamic Workflow",
                            workflow_type: "GENERATION",
                            // No primary_media_id column on workflow row!
                            folder_id: null,
                            create_time: new Date().toISOString(),
                        },
                    ],
                },
                characters: { findByProject: async () => [] },
                elements: { findByProject: async () => [] },
            };

            const service = new ProjectReadService({ db: mockDb });
            const result = await service.getProjectData({ projectId, userId });

            assert.equal(result.workflows.length, 1);
            const wf = result.workflows[0];
            // Backward-compatible projection: primary_media_id derived from workflow_media.is_primary
            assert.equal(wf.primary_media_id, targetMediaId);
            assert.equal(wf.primaryMediaId, targetMediaId);
            assert.equal(wf.items.length, 1);
            assert.equal(wf.items[0].is_primary, true);
        } finally {
            supabase.from = origFrom;
            supabaseAdmin.from = origAdminFrom;
        }
    });

    it("WorkflowMediaService: deleting a pinned primary relation never auto-promotes another media item", async () => {
        let unlinkedMedia = null;
        let deletedMedia = null;

        const mockDb = {
            media: {
                findById: async (id) => ({ id, status: "completed", url: "https://example.com/test.png" }),
                findByWorkflow: async () => [
                    { id: "m-remaining", status: "completed", url: "https://example.com/rem.png" },
                ],
                deleteById: async (mediaId) => { deletedMedia = mediaId; return { id: mediaId }; },
                deleteByIdAndWorkflow: async (mediaId) => { deletedMedia = mediaId; return { id: mediaId }; },
                client: () => ({ from: () => ({ delete: () => ({ eq: async () => ({}) }) }) }),
            },
            workflowMedia: {
                unlink: async ({ workflowId, mediaId }) => { unlinkedMedia = { workflowId, mediaId }; },
                countLinksForMedia: async () => 0,
                clearPrimaryMedia: async () => {},
                unlinkAndReapOrphan: async ({ workflowId, mediaId }) => {
                    unlinkedMedia = { workflowId, mediaId };
                    return { unlinked: true, is_orphan: true, storage_url: "https://example.com/test.png", remaining_links: 0, was_primary: true };
                },
                findByMedia: async () => [],
            },
            workflows: {
                findById: async () => ({ id: "wf-1", workflow_type: "GENERATION" }),
                updatePrimaryMedia: async () => { throw new Error("Must NOT auto-promote another primary media"); },
                updateFields: async () => ({ id: "wf-1" }),
            },
            elements: { findByWorkflowId: async () => null },
            characters: { findByWorkflowId: async () => null },
        };

        const authService = { verifyMediaOwnership: async () => true, verifyWorkflowOwnership: async () => true };
        const storageService = { deleteByUrl: async () => true };
        const service = new WorkflowMediaService({ db: mockDb, authService, storageService, mediaUploadService: { discard: async () => ({}) } });

        const res = await service.deleteMedia({
            mediaId: "m-pinned",
            workflowId: "wf-1",
            userId: "u-1",
        });

        assert.equal(res.deleted, true);
        assert.equal(res.next_primary_media_id, null, "Deleting pinned media must never auto-promote next primary media");
    });

    it("V1StorageBridge: creates placeholder without generation_config table or session_id column", async () => {
        let createdWf = null;
        let createdMedia = null;

        const mockDb = {
            workflows: {
                createWorkflow: async (data) => {
                    createdWf = data;
                    return { id: "wf-v1-bridge", ...data };
                },
            },
            media: {
                createMedia: async (data) => {
                    createdMedia = data;
                    return { id: "media-v1-bridge", ...data };
                },
            },
            workflowMedia: {
                linkMedia: async (link) => link,
                setPrimaryMedia: async () => ({ is_primary: true }),
            },
            folders: { findOwnedInProject: async () => null },
            projects: { client: () => ({ from: () => ({ insert: async () => ({}) }) }) },
        };

        const bridge = new V1StorageBridge({ db: mockDb });
        const res = await bridge.createV1Placeholder({
            userId: "u-1",
            projectId: "p-1",
            displayName: "Test Gen",
            workflowType: "GENERATION",
            config: { prompt: "A cyberpunk city", model: "imagen-3", aspect_ratio: "16:9" },
        });

        assert.equal(res.workflow.id, "wf-v1-bridge");
        assert.equal("session_id" in createdWf, false, "Workflow payload must not include session_id");
        assert.equal("generation_config_id" in createdMedia, false, "Media payload must not include generation_config_id");
    });

    it("ProjectReadService: queries media with generation_config but without metadata or generation_config_id", async () => {
        const projectId = "11111111-1111-4111-8111-111111111111";
        const userId = "22222222-2222-4222-8222-222222222222";
        let mediaSelectColumns = null;

        const origFrom = supabase.from;
        const origAdminFrom = supabaseAdmin.from;

        supabase.from = (table) => {
            if (table === "project") {
                return {
                    select: () => ({
                        eq: () => ({
                            single: async () => ({
                                data: { id: projectId, user_id: userId, project_name: "Test Project" },
                                error: null,
                            }),
                        }),
                    }),
                };
            }
            if (table === "media") {
                return {
                    select: (cols) => {
                        mediaSelectColumns = cols;
                        return {
                            eq: () => ({
                                order: async () => ({
                                    data: [],
                                    error: null,
                                }),
                            }),
                        };
                    },
                };
            }
            return origFrom.call(supabase, table);
        };

        const mockDb = {
            workflows: {
                findByProject: async () => [],
            },
        };

        try {
            const service = new ProjectReadService({ db: mockDb });
            await service.getProjectData({ projectId, userId });

            assert.ok(mediaSelectColumns, "Expected media table to be queried");
            assert.equal(mediaSelectColumns.includes("metadata"), false, "media select must not query media.metadata");
            assert.equal(mediaSelectColumns.includes("generation_config_id"), false, "media select must not query media.generation_config_id");
            assert.equal(mediaSelectColumns.includes("generation_config"), true, "media select must include generation_config for reuse prompt");
        } finally {
            supabase.from = origFrom;
            supabaseAdmin.from = origAdminFrom;
        }
    });

    it("ADR-0008: multi-workflow asset preserves technical media.step_id while role reflects relation purpose", async () => {
        const projectId = "11111111-1111-4111-8111-111111111111";
        const userId = "22222222-2222-4222-8222-222222222222";
        const mediaId = "m-shared-origin-gen";

        const origFrom = supabase.from;
        const origAdminFrom = supabaseAdmin.from;

        supabase.from = (table) => {
            if (table === "project") {
                return {
                    select: () => ({
                        eq: () => ({
                            single: async () => ({
                                data: { id: projectId, user_id: userId, project_name: "Test Project" },
                                error: null,
                            }),
                        }),
                    }),
                };
            }
            if (table === "media") {
                return {
                    select: () => ({
                        eq: () => ({
                            order: async () => ({
                                data: [
                                    {
                                        id: mediaId,
                                        project_id: projectId,
                                        status: "success",
                                        url: "https://example.com/asset.png",
                                        width: 1024,
                                        height: 1024,
                                        step_id: "image_generation",
                                        create_time: new Date().toISOString(),
                                    },
                                ],
                                error: null,
                            }),
                        }),
                    }),
                };
            }
            if (table === "workflow_media") {
                return {
                    select: () => ({
                        in: async () => ({
                            data: [
                                {
                                    workflow_id: "wf-gen",
                                    media_id: mediaId,
                                    role: "output",
                                    is_primary: true,
                                    metadata: {},
                                    created_at: new Date().toISOString(),
                                },
                                {
                                    workflow_id: "wf-char",
                                    media_id: mediaId,
                                    role: "detail",
                                    is_primary: false,
                                    metadata: {},
                                    created_at: new Date().toISOString(),
                                },
                            ],
                            error: null,
                        }),
                    }),
                };
            }
            if (table === "element" || table === "characters") {
                return {
                    select: () => ({
                        in: async () => ({ data: [], error: null }),
                        eq: async () => ({ data: [], error: null }),
                        or: async () => ({ data: [], error: null }),
                    }),
                };
            }
            return origFrom.call(supabase, table);
        };

        const mockDb = {
            workflows: {
                findByProject: async () => [
                    { id: "wf-gen", display_name: "Generation Workflow", workflow_type: "GENERATION" },
                    { id: "wf-char", display_name: "Character Workflow", workflow_type: "CHARACTER" },
                ],
            },
        };

        try {
            const service = new ProjectReadService({ db: mockDb });
            const result = await service.getProjectData({ projectId, userId });

            const genWorkflow = result.workflows.find((w) => w.id === "wf-gen");
            const charWorkflow = result.workflows.find((w) => w.id === "wf-char");

            assert.equal(genWorkflow.items.length, 1);
            assert.equal(genWorkflow.items[0].role, "output");
            assert.equal(genWorkflow.items[0].step_id, "image_generation");

            assert.equal(charWorkflow.items.length, 1);
            assert.equal(charWorkflow.items[0].role, "detail");
        } finally {
            supabase.from = origFrom;
            supabaseAdmin.from = origAdminFrom;
        }
    });
});

