import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ProjectReadService } from "#workspace/tools";
import { MediaRepository } from "#media/tools";
import { supabase, supabaseAdmin } from "#shared/db/supabase.js";
import { WorkflowRepository } from "#generation/tools";
import { ElementRepository } from "#elements/tools";
import { CharacterRepository } from "#characters/tools";
import { assertOwns, setDb } from "#identity/tools";
import express from "express";
import http from "node:http";
import apiRouter from "../../../src/api/routes.js";
import { db } from "../../../src/container.js";
import { redisConnection, workerRedisConnection, rateLimitRedisConnection } from "#shared";

// ─── Source: projectReadServiceFallback.test.js ───
{
describe("ProjectReadService - Primary Media Fallback & Items Attachment", () => {
    it("returns saved generation parameters in project data", async () => {
        const projectId = "11111111-1111-4111-8111-111111111111";
        const userId = "22222222-2222-4222-8222-222222222222";
        const workflowId = "33333333-3333-4333-8333-333333333333";
        const mediaId = "44444444-4444-4444-8444-444444444444";
        const parameters = { quality: "medium", resolution: "1k", aspect_ratio: "16:9" };
        const service = new ProjectReadService({
            db: {
                projects: { findById: async () => ({ id: projectId, user_id: userId }) },
                workflows: {
                    findByProject: async () => [{
                        id: workflowId,
                        project_id: projectId,
                        workflow_type: "GENERATION",
                        primary_media_id: mediaId,
                    }],
                },
                media: {
                    findByProjectAll: async () => [{
                        id: mediaId,
                        project_id: projectId,
                        status: "failed",
                        url: null,
                        width: 1344,
                        height: 768,
                        step_id: "image_generation",
                        generation_config: {
                            model: "gpt_image_2",
                            prompt: "Saved failed prompt",
                            aspect_ratio: "16:9",
                            parameters,
                        },
                    }],
                },
                workflowMedia: {
                    findRelationsByWorkflowIds: async () => [{
                        workflow_id: workflowId,
                        media_id: mediaId,
                        role: "output",
                        is_primary: true,
                    }],
                },
                characters: { findByProjectOrWorkflowIds: async () => [] },
                elements: { findByWorkflowIds: async () => [] },
            },
        });

        const projectData = await service.getProjectData({ projectId, userId });

        assert.deepEqual(projectData.media[0].generationConfig.parameters, parameters);
    });

    it("selects generation_config when loading all project media", async () => {
        const originalFrom = supabase.from;
        const originalAdminFrom = supabaseAdmin.from;
        let selectedColumns = "";
        const mockFrom = () => ({
            select(columns) {
                selectedColumns = columns;
                return { eq: () => ({ order: async () => ({ data: [], error: null }) }) };
            },
        });
        supabase.from = mockFrom;
        supabaseAdmin.from = mockFrom;

        try {
            await new MediaRepository().findByProjectAll("project-id");
            assert.match(selectedColumns, /generation_config/);
        } finally {
            supabase.from = originalFrom;
            supabaseAdmin.from = originalAdminFrom;
        }
    });

    it("defensively attributes media to workflow when workflow_media row is missing but primary_media_id is set", async () => {
        const projectId = "11111111-1111-4111-8111-111111111111";
        const userId = "22222222-2222-4222-8222-222222222222";
        const targetMediaId = "33333333-3333-4333-8333-333333333333";
        const targetWorkflowId = "44444444-4444-4444-8444-444444444444";

        const origFrom = supabase.from;
        const origAdminFrom = supabaseAdmin.from;
        const mockFrom = (table) => {
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
                        or: async () => ({ data: [], error: null }),
                    }),
                };
            }
            return origFrom.call(supabase, table);
        };
        supabase.from = mockFrom;
        supabaseAdmin.from = mockFrom;

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
            supabaseAdmin.from = origAdminFrom;
        }
    });

    it("returns generatedImage metadata for edited media inside an UPLOAD workflow while preserving userUploadedImage on the original upload", async () => {
        const projectId = "11111111-1111-4111-8111-111111111111";
        const userId = "22222222-2222-4222-8222-222222222222";
        const workflowId = "55555555-5555-4555-8555-555555555555";
        const originalMediaId = "66666666-6666-4666-8666-666666666666";
        const editedMediaId = "77777777-7777-4777-8777-777777777777";

        const service = new ProjectReadService({
            db: {
                projects: { findById: async () => ({ id: projectId, user_id: userId, project_name: "Edit Upload Project" }) },
                workflows: {
                    findByProject: async () => ({
                        active: [{
                            id: workflowId,
                            project_id: projectId,
                            display_name: "portrait_upload.png",
                            workflow_type: "UPLOAD",
                            create_time: "2026-11-25T07:00:00Z",
                        }],
                        trashed: [],
                    }),
                },
                media: {
                    findByProjectAll: async () => [
                        {
                            id: originalMediaId,
                            project_id: projectId,
                            status: "success",
                            url: "https://cdn.example.com/uploads/portrait.png",
                            width: 1024,
                            height: 1536,
                            step_id: "upload",
                            create_time: "2026-11-25T07:00:00Z",
                            generation_config: null,
                        },
                        {
                            id: editedMediaId,
                            project_id: projectId,
                            status: "success",
                            url: "https://cdn.example.com/edits/portrait-relit.png",
                            width: 1024,
                            height: 1536,
                            step_id: "image_relight",
                            create_time: "2026-11-25T07:05:00Z",
                            generation_config: {
                                prompt: "Warm golden studio relight",
                                model: "nanobana_2",
                                edit_type: "relight",
                                source_media_id: originalMediaId,
                                aspect_ratio: "2:3",
                                parameters: { resolution: "1k" },
                            },
                        },
                    ],
                },
                workflowMedia: {
                    findRelationsByWorkflowIds: async () => [
                        {
                            workflow_id: workflowId,
                            media_id: originalMediaId,
                            role: "original",
                            is_primary: false,
                        },
                        {
                            workflow_id: workflowId,
                            media_id: editedMediaId,
                            role: "output",
                            is_primary: true,
                        },
                    ],
                },
                characters: { findByProjectOrWorkflowIds: async () => [] },
                elements: { findByWorkflowIds: async () => [] },
            },
        });

        const projectData = await service.getProjectData({ projectId, userId });
        const origDto = projectData.media.find((m) => m.id === originalMediaId);
        const editDto = projectData.media.find((m) => m.id === editedMediaId);

        assert.ok(origDto, "original uploaded media must be present");
        assert.equal(origDto.image.generatedImage, null);
        assert.deepEqual(origDto.image.userUploadedImage, { aspectRatio: "2:3" });

        assert.ok(editDto, "edited media inside UPLOAD workflow must be present");
        assert.equal(editDto.is_primary, true);
        assert.equal(editDto.image.userUploadedImage, undefined, "edited output must not be tagged as userUploadedImage");
        assert.ok(editDto.image.generatedImage, "edited output inside UPLOAD workflow must expose generatedImage metadata");
        assert.equal(editDto.image.generatedImage.prompt, "Warm golden studio relight");
        assert.equal(editDto.image.generatedImage.modelNameType, "nanobana_2");
        assert.equal(editDto.image.generatedImage.workflowId, workflowId);
        assert.equal(editDto.image.generatedImage.aspectRatio, "2:3");
        assert.equal(editDto.image.generatedImage.url, "https://cdn.example.com/edits/portrait-relit.png");
        assert.equal(editDto.image.generatedImage.editType, "relight");
        assert.equal(editDto.image.generatedImage.sourceMediaId, originalMediaId);
        assert.deepEqual(editDto.mediaMetadata.requestData.imageGenerationRequestData, {});
    });
});
}

// ─── Source: projectReadServiceTrashRework.test.js ───
{
/**
 * Builds an in-memory Supabase table query simulator supporting
 * select, eq, in, not, is, or, ilike, order, range, limit, maybeSingle, single.
 */
function createTableClient(tables) {
    return {
        from(tableName) {
            const rows = tables[tableName] || [];
            const filters = [];
            const orders = [];
            let rangeSpec = null;
            let limitCount = null;

            const applyFilters = () => {
                return rows.filter((row) =>
                    filters.every((fn) => fn(row))
                );
            };

            const execute = () => {
                let matched = applyFilters();
                for (const { col, ascending } of orders) {
                    matched = [...matched].sort((a, b) => {
                        const va = a[col] ?? "";
                        const vb = b[col] ?? "";
                        if (va === vb) return 0;
                        return ascending ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
                    });
                }
                if (rangeSpec) {
                    matched = matched.slice(rangeSpec.from, rangeSpec.to + 1);
                } else if (typeof limitCount === "number") {
                    matched = matched.slice(0, limitCount);
                }
                return { data: matched, error: null };
            };

            const builder = {
                select() { return builder; },
                eq(col, val) {
                    filters.push((row) => row[col] === val);
                    return builder;
                },
                in(col, vals) {
                    const set = new Set(vals);
                    filters.push((row) => set.has(row[col]));
                    return builder;
                },
                not(col, op, val) {
                    if (op === "is" && val === null) {
                        filters.push((row) => row[col] !== null && row[col] !== undefined);
                    }
                    return builder;
                },
                is(col, val) {
                    filters.push((row) => row[col] === val);
                    return builder;
                },
                or(expr) {
                    filters.push((row) => {
                        const parts = expr.split(",");
                        return parts.some((p) => {
                            const [field, op, val] = p.split(".");
                            if (op === "eq") return row[field] === val;
                            if (op === "in") {
                                const list = val.replace(/^\(|\)$/g, "").split(",");
                                return list.includes(row[field]);
                            }
                            return false;
                        });
                    });
                    return builder;
                },
                order(column, { ascending = true } = {}) {
                    orders.push({ col: column, ascending });
                    return builder;
                },
                range(from, to) {
                    rangeSpec = { from, to };
                    return builder;
                },
                limit(count) {
                    limitCount = count;
                    return builder;
                },
                then(resolve, reject) {
                    try {
                        const res = execute();
                        return Promise.resolve(resolve(res));
                    } catch (err) {
                        return Promise.reject(reject ? reject(err) : err);
                    }
                },
            };
            return builder;
        },
    };
}

describe("ProjectReadService: Trash Rework & Media Isolation", () => {
    it("STEP 1: Trashed workflow media must NOT appear in projectContents.media, but appears in projectContents.trashedWorkflows", async () => {
        const tables = {
            project: [{ id: "proj-1", project_name: "Studio Proj", user_id: "user-1" }],
            workflow: [
                {
                    id: "wf-active",
                    project_id: "proj-1",
                    display_name: "Active Generation",
                    workflow_type: "GENERATION",
                    create_time: "2026-10-25T10:00:00.000Z",
                    primary_media_id: "media-active",
                },
                {
                    id: "wf-trashed",
                    project_id: "proj-1",
                    display_name: "Trashed Generation",
                    workflow_type: "GENERATION",
                    create_time: "2026-10-25T11:00:00.000Z",
                    primary_media_id: "media-trashed",
                },
            ],
            element: [],
            characters: [],
            media: [
                {
                    id: "media-active",
                    project_id: "proj-1",
                    url: "https://storage/active.png",
                    width: 1024,
                    height: 1024,
                    status: "completed",
                    create_time: "2026-10-25T10:01:00.000Z",
                },
                {
                    id: "media-trashed",
                    project_id: "proj-1",
                    url: "https://storage/trashed.png",
                    width: 1024,
                    height: 1024,
                    status: "completed",
                    create_time: "2026-10-25T11:01:00.000Z",
                },
            ],
            workflow_media: [
                {
                    workflow_id: "wf-active",
                    media_id: "media-active",
                    role: "output",
                    is_primary: true,
                    created_at: "2026-10-25T10:01:00.000Z",
                },
                {
                    workflow_id: "wf-trashed",
                    media_id: "media-trashed",
                    role: "output",
                    is_primary: true,
                    created_at: "2026-10-25T11:01:00.000Z",
                },
            ],
            trash: [
                { id: "t-1", workflow_id: "wf-trashed", user_id: "user-1", deleted_at: "2026-10-25T12:00:00.000Z" },
            ],
        };

        const mockClient = createTableClient(tables);
        const origSupabaseFrom = supabase.from;
        const origAdminFrom = supabaseAdmin.from;
        supabase.from = mockClient.from.bind(mockClient);
        supabaseAdmin.from = mockClient.from.bind(mockClient);

        try {
            const db = {
                projects: { findById: async (id) => tables.project.find((p) => p.id === id) || null },
                workflows: new WorkflowRepository(),
                elements: new ElementRepository(),
                characters: new CharacterRepository(),
                media: { findByProjectAll: async () => tables.media },
                workflowMedia: {
                    findRelationsByWorkflowIds: async (wfIds) =>
                        tables.workflow_media.filter((wm) => wfIds.includes(wm.workflow_id)),
                },
            };
            const service = new ProjectReadService({ db });

            const result = await service.getProjectData({ projectId: "proj-1", userId: "user-1" });

            // Active workflows must contain ONLY wf-active
            assert.deepEqual(
                result.workflows.map((w) => w.id),
                ["wf-active"],
                "projectContents.workflows must contain only active workflows"
            );

            // Active media must contain ONLY media-active (media-trashed must NOT appear!)
            assert.deepEqual(
                result.media.map((m) => m.id),
                ["media-active"],
                "projectContents.media must contain only active media, excluding media from trashed workflows"
            );

            // trashedWorkflows must contain wf-trashed with its media and deleted_at
            assert.ok(Array.isArray(result.trashedWorkflows), "trashedWorkflows must be an array");
            assert.equal(result.trashedWorkflows.length, 1, "trashedWorkflows must contain exactly 1 item");
            const trashedWf = result.trashedWorkflows[0];
            assert.equal(trashedWf.id, "wf-trashed");
            assert.equal(trashedWf.display_name, "Trashed Generation");
            assert.equal(trashedWf.deleted_at, "2026-10-25T12:00:00.000Z");
            assert.equal(trashedWf.primary_media_id, "media-trashed");
            assert.ok(Array.isArray(trashedWf.media), "trashed workflow must have media array");
            assert.equal(trashedWf.media.length, 1);
            assert.equal(trashedWf.media[0].id, "media-trashed");
            assert.equal(trashedWf.media[0].url, "https://storage/trashed.png");
        } finally {
            supabase.from = origSupabaseFrom;
            supabaseAdmin.from = origAdminFrom;
        }
    });

    it("STEP 2: Empty trash returns empty trashedWorkflows array; restore brings workflow and media back to active arrays; foreign project throws 404", async () => {
        const tables = {
            project: [
                { id: "proj-1", project_name: "Studio Proj", user_id: "user-1" },
                { id: "proj-foreign", project_name: "Foreign Proj", user_id: "user-other" },
            ],
            workflow: [
                {
                    id: "wf-1",
                    project_id: "proj-1",
                    display_name: "Test Generation",
                    workflow_type: "GENERATION",
                    create_time: "2026-10-25T10:00:00.000Z",
                    primary_media_id: "media-1",
                },
            ],
            element: [],
            characters: [],
            media: [
                {
                    id: "media-1",
                    project_id: "proj-1",
                    url: "https://storage/1.png",
                    width: 1024,
                    height: 1024,
                    status: "completed",
                    create_time: "2026-10-25T10:01:00.000Z",
                },
            ],
            workflow_media: [
                {
                    workflow_id: "wf-1",
                    media_id: "media-1",
                    role: "output",
                    is_primary: true,
                    created_at: "2026-10-25T10:01:00.000Z",
                },
            ],
            trash: [],
        };

        const mockClient = createTableClient(tables);
        const origSupabaseFrom = supabase.from;
        const origAdminFrom = supabaseAdmin.from;
        supabase.from = mockClient.from.bind(mockClient);
        supabaseAdmin.from = mockClient.from.bind(mockClient);

        try {
            const db = {
                projects: { findById: async (id) => tables.project.find((p) => p.id === id) || null },
                workflows: new WorkflowRepository(),
                elements: new ElementRepository(),
                characters: new CharacterRepository(),
                media: { findByProjectAll: async () => tables.media },
                workflowMedia: {
                    findRelationsByWorkflowIds: async (wfIds) =>
                        tables.workflow_media.filter((wm) => wfIds.includes(wm.workflow_id)),
                },
            };
            setDb(db);
            const service = new ProjectReadService({ db });

            // A: Project without trash -> trashedWorkflows is empty array
            const resClean = await service.getProjectData({ projectId: "proj-1", userId: "user-1" });
            assert.deepEqual(resClean.trashedWorkflows, []);
            assert.equal(resClean.workflows.length, 1);
            assert.equal(resClean.media.length, 1);

            // B: Foreign project -> throws 404
            const prevBypass = process.env.DEV_AUTH_BYPASS;
            process.env.DEV_AUTH_BYPASS = "false";
            try {
                await assert.rejects(
                    async () => service.getProjectData({ projectId: "proj-foreign", userId: "user-1" }),
                    (err) => err?.statusCode === 404,
                    "Accessing another user's project must throw 404"
                );
            } finally {
                process.env.DEV_AUTH_BYPASS = prevBypass;
            }

            // C: Move wf-1 to trash -> moves to trashedWorkflows, excluded from active
            tables.trash.push({ id: "t-1", workflow_id: "wf-1", user_id: "user-1", deleted_at: "2026-10-25T12:00:00.000Z" });
            const resTrashed = await service.getProjectData({ projectId: "proj-1", userId: "user-1" });
            assert.deepEqual(resTrashed.workflows, []);
            assert.deepEqual(resTrashed.media, []);
            assert.equal(resTrashed.trashedWorkflows.length, 1);
            assert.equal(resTrashed.trashedWorkflows[0].id, "wf-1");

            // D: Restore wf-1 (remove trash row) -> reappears in workflows and media, disappears from trashedWorkflows
            tables.trash.length = 0;
            const resRestored = await service.getProjectData({ projectId: "proj-1", userId: "user-1" });
            assert.equal(resRestored.workflows.length, 1);
            assert.equal(resRestored.workflows[0].id, "wf-1");
            assert.equal(resRestored.media.length, 1);
            assert.equal(resRestored.media[0].id, "media-1");
            assert.deepEqual(resRestored.trashedWorkflows, []);
        } finally {
            supabase.from = origSupabaseFrom;
            supabaseAdmin.from = origAdminFrom;
        }
    });

    it("STEP 3: When trash table query fails (e.g. migration not applied), active workflows are still preserved", async () => {
        const tables = {
            project: [{ id: "proj-1", project_name: "Studio Proj", user_id: "user-1" }],
            workflow: [
                {
                    id: "wf-1",
                    project_id: "proj-1",
                    display_name: "Active 1",
                    workflow_type: "GENERATION",
                    create_time: "2026-10-25T10:00:00.000Z",
                    primary_media_id: "media-1",
                },
            ],
            element: [],
            characters: [],
            media: [
                {
                    id: "media-1",
                    project_id: "proj-1",
                    url: "https://storage/1.png",
                    width: 1024,
                    height: 1024,
                    status: "completed",
                    create_time: "2026-10-25T10:01:00.000Z",
                },
            ],
            workflow_media: [
                {
                    workflow_id: "wf-1",
                    media_id: "media-1",
                    role: "output",
                    is_primary: true,
                    created_at: "2026-10-25T10:01:00.000Z",
                },
            ],
        };

        const client = createTableClient(tables);
        const origFrom = client.from;
        client.from = (tableName) => {
            if (tableName === "trash") {
                return {
                    select() {
                        return {
                            in() {
                                return Promise.reject(new Error('relation "trash" does not exist'));
                            },
                        };
                    },
                };
            }
            return origFrom(tableName);
        };

        const origSupabaseFrom = supabase.from;
        const origAdminFrom = supabaseAdmin.from;
        supabase.from = client.from.bind(client);
        supabaseAdmin.from = client.from.bind(client);

        try {
            const workflowRepo = new WorkflowRepository("workflow");
            const dbMock = {
                workflows: workflowRepo,
                projects: {
                    findById: async () => ({ id: "proj-1", project_name: "Studio Proj", user_id: "user-1" }),
                },
                media: {
                    findByProjectAll: async () => tables.media,
                },
                elements: new ElementRepository("element"),
                characters: new CharacterRepository("characters"),
            };

            const service = new ProjectReadService({ db: dbMock });
            const res = await service.getProjectData({ projectId: "proj-1", userId: "user-1" });

            assert.equal(res.workflows.length, 1, "Active workflows should be preserved even if trash table fails");
            assert.equal(res.workflows[0].id, "wf-1");
            assert.deepEqual(res.trashedWorkflows, []);
        } finally {
            supabase.from = origSupabaseFrom;
            supabaseAdmin.from = origAdminFrom;
        }
    });

    it("Active workflows and elements are returned when workflow table does not have primary_media_id (ADR-0007)", async () => {
        const tables = {
            workflow: [
                {
                    id: "wf-1",
                    project_id: "proj-1",
                    display_name: "Workflow 1",
                    create_time: "2026-10-25T10:00:00.000Z",
                    workflow_type: "GENERATION",
                    folder_id: null,
                    favorited: false,
                },
            ],
            trash: [],
            media: [
                {
                    id: "media-1",
                    project_id: "proj-1",
                    url: "https://storage/1.png",
                    width: 1024,
                    height: 1024,
                    status: "completed",
                    create_time: "2026-10-25T10:01:00.000Z",
                },
            ],
            workflow_media: [
                {
                    workflow_id: "wf-1",
                    media_id: "media-1",
                    role: "output",
                    is_primary: true,
                    created_at: "2026-10-25T10:01:00.000Z",
                },
            ],
            element: [],
            characters: [],
        };

        const client = createTableClient(tables);
        const origFrom = client.from;
        client.from = (tableName) => {
            const builder = origFrom(tableName);
            const origSelect = builder.select;
            builder.select = (cols) => {
                if (tableName === "workflow" && typeof cols === "string" && cols.includes("primary_media_id")) {
                    const failBuilder = {
                        order() { return failBuilder; },
                        eq() { return Promise.reject(new Error("column workflow.primary_media_id does not exist")); },
                    };
                    return failBuilder;
                }
                return origSelect(cols);
            };
            return builder;
        };

        const origSupabaseFrom = supabase.from;
        const origAdminFrom = supabaseAdmin.from;
        supabase.from = client.from.bind(client);
        supabaseAdmin.from = client.from.bind(client);

        try {
            const workflowRepo = new WorkflowRepository("workflow");
            const dbMock = {
                workflows: workflowRepo,
                projects: {
                    findById: async () => ({ id: "proj-1", project_name: "Studio Proj", user_id: "user-1" }),
                },
                media: {
                    findByProjectAll: async () => tables.media,
                },
                elements: new ElementRepository("element"),
                characters: new CharacterRepository("characters"),
            };

            const service = new ProjectReadService({ db: dbMock });
            const res = await service.getProjectData({ projectId: "proj-1", userId: "user-1" });

            assert.equal(res.workflows.length, 1, "Workflows must be returned when primary_media_id is omitted/dropped from workflow table");
            assert.equal(res.workflows[0].id, "wf-1");
            assert.equal(res.workflows[0].primary_media_id, "media-1", "primary_media_id should be derived from workflow_media.is_primary");
        } finally {
            supabase.from = origSupabaseFrom;
            supabaseAdmin.from = origAdminFrom;
        }
    });
});
}

// ─── Source: assetListingWithFolders.test.js ───
{
process.env.NODE_ENV = "test";

describe("Asset Listing with Folder Filters & Pagination (Task F-T7)", () => {
  let server;
  let baseUrl;
  let origGetUser;

  // In-memory data store for the test suite
  let projects = [];
  let folders = [];
  let workflows = [];

  before(async () => {
    origGetUser = supabase.auth.getUser;
    supabase.auth.getUser = async (token) => {
      if (token === "token-user-A") {
        return { data: { user: { id: "user-A" } }, error: null };
      }
      if (token === "token-user-B") {
        return { data: { user: { id: "user-B" } }, error: null };
      }
      return { data: { user: null }, error: new Error("Invalid token") };
    };

    const app = express();
    app.use(express.json());
    app.use("/api", apiRouter);
    app.use((err, req, res, next) => {
      res.status(err.statusCode || 500).json({
        ok: false,
        message: err.message,
        errorCode: err.errorCode || "INTERNAL_ERROR",
      });
    });

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    supabase.auth.getUser = origGetUser;
    try {
      await redisConnection?.quit().catch(() => redisConnection?.disconnect());
      await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
      await rateLimitRedisConnection?.quit().catch(() => rateLimitRedisConnection?.disconnect());
    } catch {}
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  beforeEach(() => {
    projects = [
      { id: "proj-A", user_id: "user-A", project_name: "Project Alpha" },
      { id: "proj-B", user_id: "user-B", project_name: "Project Beta" },
    ];

    // Tree:
    // folder-root-1 (root)
    //   └── folder-sub-1 (child of folder-root-1)
    // folder-root-2 (root)
    folders = [
      {
        id: "folder-root-1",
        project_id: "proj-A",
        user_id: "user-A",
        parent_id: null,
        name: "Scenes",
        position: 0,
        create_time: "2026-10-07T10:00:00.000Z",
      },
      {
        id: "folder-sub-1",
        project_id: "proj-A",
        user_id: "user-A",
        parent_id: "folder-root-1",
        name: "Scene 1",
        position: 0,
        create_time: "2026-10-07T10:05:00.000Z",
      },
      {
        id: "folder-root-2",
        project_id: "proj-A",
        user_id: "user-A",
        parent_id: null,
        name: "Characters",
        position: 1,
        create_time: "2026-10-07T10:10:00.000Z",
      },
      {
        id: "folder-foreign",
        project_id: "proj-B",
        user_id: "user-B",
        parent_id: null,
        name: "Foreign Folder",
        position: 0,
        create_time: "2026-10-07T10:00:00.000Z",
      },
    ];

    // Workflows:
    // wf-root-asset (folder_id: null)
    // wf-in-root-1  (folder_id: folder-root-1)
    // wf-in-sub-1   (folder_id: folder-sub-1)
    // wf-in-root-2  (folder_id: folder-root-2)
    // wf-foreign    (proj-B, user-B)
    workflows = [
      {
        id: "wf-1",
        project_id: "proj-A",
        user_id: "user-A",
        folder_id: null,
        display_name: "Root Asset 1",
        create_time: "2026-10-07T11:00:00.000Z",
      },
      {
        id: "wf-2",
        project_id: "proj-A",
        user_id: "user-A",
        folder_id: "folder-root-1",
        display_name: "In Root 1",
        create_time: "2026-10-07T11:05:00.000Z",
      },
      {
        id: "wf-3",
        project_id: "proj-A",
        user_id: "user-A",
        folder_id: "folder-sub-1",
        display_name: "In Sub 1",
        create_time: "2026-10-07T11:10:00.000Z",
      },
      {
        id: "wf-4",
        project_id: "proj-A",
        user_id: "user-A",
        folder_id: "folder-root-2",
        display_name: "In Root 2",
        create_time: "2026-10-07T11:15:00.000Z",
      },
      {
        id: "wf-5",
        project_id: "proj-B",
        user_id: "user-B",
        folder_id: null,
        display_name: "Foreign WF",
        create_time: "2026-10-07T11:20:00.000Z",
      },
    ];

    // Mock db.projects
    db.projects.findByUser = async (userId, projectId) => {
      return projects.filter(
        (p) => p.user_id === userId && (!projectId || p.id === projectId)
      );
    };
    db.projects.findById = async (id) => {
      return projects.find((p) => p.id === id) || null;
    };

    // Mock db.folders
    db.folders.listByProject = async (projectId, userId) => {
      return folders.filter((f) => f.project_id === projectId && f.user_id === userId);
    };
    db.folders.findOwnedInProject = async (folderId, projectId, userId) => {
      return (
        folders.find(
          (f) => f.id === folderId && f.project_id === projectId && f.user_id === userId
        ) || null
      );
    };
    db.folders.countAssetsByFolder = async (projectId, userId) => {
      const counts = {};
      for (const w of workflows) {
        if (w.project_id === projectId && w.folder_id) {
          counts[w.folder_id] = (counts[w.folder_id] || 0) + 1;
        }
      }
      return counts;
    };

    // Mock db.workflows
    db.workflows.listProjectAssets = async (projectId, { folderIds, folderIdNull, limit = 50, cursor } = {}) => {
      let list = workflows.filter((w) => w.project_id === projectId);
      if (folderIdNull) {
        list = list.filter((w) => w.folder_id === null || w.folder_id === undefined);
      } else if (Array.isArray(folderIds)) {
        list = list.filter((w) => folderIds.includes(w.folder_id));
      }

      // Order newest first
      list.sort((a, b) => {
        if (b.create_time !== a.create_time) return b.create_time.localeCompare(a.create_time);
        return b.id.localeCompare(a.id);
      });

      if (cursor && cursor.createTime) {
        list = list.filter((w) => {
          if (w.create_time < cursor.createTime) return true;
          if (w.create_time === cursor.createTime && w.id < cursor.id) return true;
          return false;
        });
      }

      return list.slice(0, limit + 1);
    };

    // Mock db.workflowMedia
    db.workflowMedia = db.workflowMedia || {};
    db.workflowMedia.findByWorkflowIds = async () => [];
  });

  describe("GET /api/projects/:projectId/assets", () => {
    it("Scenario 9.1: returns all project assets when folderId is omitted", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-A/assets`, {
        headers: { Authorization: "Bearer token-user-A" },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.items.length, 4);
      assert.equal(data.nextCursor, null);
      // Verify serialized DTO format
      assert.equal(data.items[0].projectId, "proj-A");
      assert.equal(typeof data.items[0].id, "string");
      assert.equal(typeof data.items[0].name, "string");
    });

    it("Scenario 9.2: returns only assets in specific folder (direct children)", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-A/assets?folderId=folder-root-1`, {
        headers: { Authorization: "Bearer token-user-A" },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.items.length, 1);
      assert.equal(data.items[0].id, "wf-2");
      assert.equal(data.items[0].folderId, "folder-root-1");
    });

    it("Scenario 9.3: returns only assets with folder_id null when folderId=none", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-A/assets?folderId=none`, {
        headers: { Authorization: "Bearer token-user-A" },
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.items.length, 1);
      assert.equal(data.items[0].id, "wf-1");
      assert.equal(data.items[0].folderId, null);
    });

    it("Scenario 9.4: returns assets in folder and sub-folders when includeDescendants=true", async () => {
      const res = await fetch(
        `${baseUrl}/api/projects/proj-A/assets?folderId=folder-root-1&includeDescendants=true`,
        { headers: { Authorization: "Bearer token-user-A" } }
      );

      assert.equal(res.status, 200);
      const data = await res.json();
      // Should include wf-2 (in folder-root-1) and wf-3 (in folder-sub-1)
      assert.equal(data.items.length, 2);
      const ids = data.items.map((i) => i.id).sort();
      assert.deepEqual(ids, ["wf-2", "wf-3"]);
    });

    it("Scenario 9.5: ignores includeDescendants when folderId=none", async () => {
      const res = await fetch(
        `${baseUrl}/api/projects/proj-A/assets?folderId=none&includeDescendants=true`,
        { headers: { Authorization: "Bearer token-user-A" } }
      );

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.items.length, 1);
      assert.equal(data.items[0].id, "wf-1");
    });

    it("Scenario 9.6: pagination across 2 pages with limit and nextCursor round-trip", async () => {
      // Page 1: limit=2
      const res1 = await fetch(`${baseUrl}/api/projects/proj-A/assets?limit=2`, {
        headers: { Authorization: "Bearer token-user-A" },
      });

      assert.equal(res1.status, 200);
      const page1 = await res1.json();
      assert.equal(page1.items.length, 2);
      assert.ok(page1.nextCursor, "Expected nextCursor on page 1");

      // Page 2: with cursor
      const res2 = await fetch(
        `${baseUrl}/api/projects/proj-A/assets?limit=2&cursor=${encodeURIComponent(page1.nextCursor)}`,
        { headers: { Authorization: "Bearer token-user-A" } }
      );

      assert.equal(res2.status, 200);
      const page2 = await res2.json();
      assert.equal(page2.items.length, 2);
      assert.equal(page2.nextCursor, null);

      // Verify no overlap
      const p1Ids = page1.items.map((i) => i.id);
      const p2Ids = page2.items.map((i) => i.id);
      for (const id of p1Ids) {
        assert.ok(!p2Ids.includes(id), `Page 2 should not contain ${id}`);
      }
      assert.equal(p1Ids.length + p2Ids.length, 4);
    });

    it("returns 400 for invalid folderId format", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-A/assets?folderId=invalid!@#$%`, {
        headers: { Authorization: "Bearer token-user-A" },
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.errorCode, "VALIDATION_ERROR");
    });

    it("returns 404 for foreign folderId (User B's folder)", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-A/assets?folderId=folder-foreign`, {
        headers: { Authorization: "Bearer token-user-A" },
      });

      assert.equal(res.status, 404);
    });

    it("returns 404 for foreign projectId (cross-tenant)", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-B/assets`, {
        headers: { Authorization: "Bearer token-user-A" },
      });

      assert.equal(res.status, 404);
    });

    it("returns 401 when unauthenticated", async () => {
      const res = await fetch(`${baseUrl}/api/projects/proj-A/assets`);
      assert.equal(res.status, 401);
    });

    it("Decision D-20: preserves existing /api/workflows/project-data/:project_id response shape", async () => {
      const { projectReadService } = await import("../../../src/container.js");
      const origGetProjectData = projectReadService.getProjectData;
      projectReadService.getProjectData = async () => ({
        projectName: "Project Alpha",
        appConfig: {},
        sessions: [],
        workflows: [{ id: "wf-1" }],
        media: [],
        elements: [],
        characters: [],
      });

      try {
        const res = await fetch(`${baseUrl}/api/workflows/project-data/proj-A`, {
          headers: { Authorization: "Bearer token-user-A" },
        });

        assert.equal(res.status, 200);
        const data = await res.json();
        assert.ok(data.result?.data?.json?.projectContents, "Expected result.data.json.projectContents shape");
        assert.ok(Array.isArray(data.result.data.json.projectContents.workflows));
      } finally {
        projectReadService.getProjectData = origGetProjectData;
      }
    });

    it("returns folder_id and folderId on workflows in /api/workflows/project-data/:projectId", async () => {
      const origFrom = supabase.from;
      const origAdminFrom = supabaseAdmin.from;
      const mockFrom = (table) => {
        if (table === "project") {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({
                  data: { id: "proj-A", user_id: "user-A", project_name: "Project A" },
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
                order: async () => ({ data: [], error: null }),
              }),
            }),
          };
        }
        if (table === "element") {
          return {
            select: () => ({
              in: async () => ({ data: [], error: null }),
            }),
          };
        }
        return origFrom?.call(supabase, table);
      };
      supabase.from = mockFrom;
      supabaseAdmin.from = mockFrom;

      const origFindByProject = db.workflows.findByProject;
      db.workflows.findByProject = async (projectId, options = {}) => {
        return [
          {
            id: "wf-2",
            display_name: "In Root 1",
            folder_id: "folder-root-1",
            workflow_type: "UPLOAD",
            create_time: "2026-10-07T11:05:00.000Z",
          },
          {
            id: "wf-1",
            display_name: "Root Asset 1",
            folder_id: null,
            workflow_type: "UPLOAD",
            create_time: "2026-10-07T11:00:00.000Z",
          },
        ];
      };

      try {
        const res = await fetch(`${baseUrl}/api/workflows/project-data/proj-A`, {
          headers: { Authorization: "Bearer token-user-A" },
        });

        assert.equal(res.status, 200);
        const data = await res.json();
        const workflowsInResponse = data.result?.data?.json?.projectContents?.workflows;
        assert.ok(workflowsInResponse, "Expected workflows array");
        const wfInFolder = workflowsInResponse.find((w) => w.id === "wf-2");
        assert.ok(wfInFolder, "Expected wf-2");
        assert.equal(wfInFolder.folder_id, "folder-root-1", "wf-2 must have folder_id");
        assert.equal(wfInFolder.folderId, "folder-root-1", "wf-2 must have folderId alias");
        assert.equal(wfInFolder.metadata?.folder_id, "folder-root-1", "metadata must have folder_id");
      } finally {
        supabase.from = origFrom;
        supabaseAdmin.from = origAdminFrom;
        db.workflows.findByProject = origFindByProject;
      }
    });

    it("returns folders and collections with color and description in /api/workflows/project-data/:projectId", async () => {
      const origFrom = supabase.from;
      const origAdminFrom = supabaseAdmin.from;
      const mockFrom = (table) => {
        if (table === "project") {
          return {
            select: () => ({
              eq: () => ({
                single: async () => ({
                  data: { id: "proj-A", user_id: "user-A", project_name: "Project A" },
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
                order: async () => ({ data: [], error: null }),
              }),
            }),
          };
        }
        if (table === "element") {
          return {
            select: () => ({
              in: async () => ({ data: [], error: null }),
            }),
          };
        }
        return origFrom?.call(supabase, table);
      };
      supabase.from = mockFrom;
      supabaseAdmin.from = mockFrom;

      const origFindByProject = db.workflows.findByProject;
      db.workflows.findByProject = async () => [];

      const origListByProject = db.folders.listByProject;
      db.folders.listByProject = async (projectId, userId) => [
        {
          id: "folder-test-1",
          project_id: projectId,
          user_id: userId,
          parent_id: null,
          name: "Design Assets",
          color: "#3B82F6",
          description: "All creative assets",
          position: 0,
          create_time: "2026-11-01T10:00:00.000Z",
        },
      ];

      try {
        const res = await fetch(`${baseUrl}/api/workflows/project-data/proj-A`, {
          headers: { Authorization: "Bearer token-user-A" },
        });

        assert.equal(res.status, 200);
        const data = await res.json();
        const json = data.result?.data?.json;
        assert.ok(json, "Expected json");

        assert.ok(Array.isArray(json.folders), "Expected json.folders array");
        assert.ok(Array.isArray(json.collections), "Expected json.collections array");
        assert.ok(Array.isArray(json.projectContents?.folders), "Expected projectContents.folders");
        assert.ok(Array.isArray(json.projectContents?.collections), "Expected projectContents.collections");

        const folder = json.projectContents.folders[0];
        assert.ok(folder);
        assert.equal(folder.id, "folder-test-1");
        assert.equal(folder.name, "Design Assets");
        assert.equal(folder.color, "#3B82F6");
        assert.equal(folder.description, "All creative assets");
      } finally {
        supabase.from = origFrom;
        supabaseAdmin.from = origAdminFrom;
        db.workflows.findByProject = origFindByProject;
        db.folders.listByProject = origListByProject;
      }
    });
  });
});
}
