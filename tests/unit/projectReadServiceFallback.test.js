import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ProjectReadService } from "../../src/domain/project/ProjectReadService.js";
import { supabase } from "../../lib/supabase.js";

describe("ProjectReadService - Primary Media Fallback & Items Attachment", () => {
    it("defensively attributes media to workflow when workflow_media row is missing but primary_media_id is set", async () => {
        const projectId = "11111111-1111-4111-8111-111111111111";
        const userId = "22222222-2222-4222-8222-222222222222";
        const targetMediaId = "33333333-3333-4333-8333-333333333333";
        const targetWorkflowId = "44444444-4444-4444-8444-444444444444";

        const origFrom = supabase.from;
        supabase.from = (table) => {
            if (table === "project") {
                return {
                    select: () => ({
                        eq: (col, val) => ({
                            single: async () => {
                                if (val === projectId) {
                                    return {
                                        data: { id: projectId, user_id: userId, project_name: "Test Project" },
                                        error: null,
                                    };
                                }
                                return { data: null, error: { message: "Not found" } };
                            },
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
                                        url: "https://example.com/upload.jpg",
                                        width: 800,
                                        height: 600,
                                        step_id: "upload",
                                        create_time: new Date().toISOString(),
                                        generation_config_id: null,
                                        generation_config: null,
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
                            data: [], // Simulate missing rows in workflow_media
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
                    }),
                };
            }
            return origFrom.call(supabase, table);
        };

        try {
            const mockDb = {
                workflows: {
                    findByProject: async (pid) => [
                        {
                            id: targetWorkflowId,
                            project_id: pid,
                            display_name: "my_upload.jpg",
                            workflow_type: "UPLOAD",
                            primary_media_id: targetMediaId,
                            folder_id: null,
                            create_time: new Date().toISOString(),
                        },
                    ],
                },
                characters: {
                    findByProject: async () => [],
                },
                elements: {
                    findByProject: async () => [],
                },
            };

            const service = new ProjectReadService({ db: mockDb });
            const result = await service.getProjectData({ projectId, userId });

            // 1. Verify media array has recovered workflowId
            assert.equal(result.media.length, 1);
            const resolvedMedia = result.media[0];
            assert.equal(resolvedMedia.id, targetMediaId);
            assert.equal(resolvedMedia.workflowId, targetWorkflowId);
            assert.equal(resolvedMedia.workflow_id, targetWorkflowId);
            assert.equal(resolvedMedia.role, "original");
            assert.equal(resolvedMedia.status, "success");
            assert.equal(resolvedMedia.url, "https://example.com/upload.jpg");

            // 2. Verify workflows array has attached items
            assert.equal(result.workflows.length, 1);
            const resolvedWorkflow = result.workflows[0];
            assert.equal(resolvedWorkflow.id, targetWorkflowId);
            assert.equal(resolvedWorkflow.items.length, 1);
            assert.equal(resolvedWorkflow.items[0].id, targetMediaId);
            assert.equal(resolvedWorkflow.items[0].url, "https://example.com/upload.jpg");
            assert.equal(resolvedWorkflow.media.length, 1);
        } finally {
            supabase.from = origFrom;
        }
    });
});
