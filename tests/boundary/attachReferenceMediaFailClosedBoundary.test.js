/**
 * Boundary tests: attachReferenceMedia must fail-closed when the atomic
 * attach RPC is unavailable.  A silent linkMedia() fallback would bypass
 * the FOR KEY SHARE lock and allow attach-vs-unlink races.
 *
 * NOTE: These tests exercise JS control-flow only.  PostgreSQL locking
 * behaviour (FOR KEY SHARE vs FOR UPDATE compatibility) is NOT proven here
 * and MUST be verified against a real PostgreSQL instance.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { WorkflowMediaRepository } from "../../src/db/WorkflowMediaRepository.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeMissingRpcClient(funcName) {
    return {
        from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
        rpc: async (name) => {
            if (name === funcName) {
                const err = new Error(`function public.${funcName}() does not exist`);
                err.code = "42883";
                return { data: null, error: err };
            }
            return { data: null, error: null };
        },
    };
}

function makePostgrestMissingFunctionClient(funcName) {
    return {
        from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
        rpc: async (name) => {
            if (name === funcName) {
                // PostgREST PGRST202 style message (no SQLSTATE)
                const err = new Error(`Could not find the function public.${funcName}(uuid, uuid, text, int4) in the schema cache`);
                err.code = null;
                return { data: null, error: err };
            }
            return { data: null, error: null };
        },
    };
}

function makeUnrelatedSchemaErrorClient(funcName) {
    return {
        from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
        rpc: async (name) => {
            if (name === funcName) {
                const err = new Error('column "nonexistent_col" of relation "workflow_media" does not exist');
                err.code = "42703"; // undefined_column — must NOT be treated as missing function
                return { data: null, error: err };
            }
            return { data: null, error: null };
        },
    };
}

function repoWithClient(client) {
    const repo = new WorkflowMediaRepository();
    repo.client = () => client;
    return repo;
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe("attachReferenceMedia — fail-closed when RPC unavailable", () => {
    beforeEach(() => {
        WorkflowMediaRepository.disableTestMemoryFallback();
    });

    afterEach(() => {
        WorkflowMediaRepository.disableTestMemoryFallback();
    });

    it("ATTACH-FC-1: PostgreSQL 42883 must throw ATTACH_RPC_UNAVAILABLE, never call linkMedia", async () => {
        const linkMediaCalled = [];
        const repo = repoWithClient(makeMissingRpcClient("attach_workflow_reference_media"));
        // Spy: if linkMedia is called, capture it
        const origLink = repo.linkMedia.bind(repo);
        repo.linkMedia = async (...args) => {
            linkMediaCalled.push(args);
            return origLink(...args);
        };

        await assert.rejects(
            () => repo.attachReferenceMedia({ workflowId: "wf-1", mediaId: "m-1" }),
            (err) => {
                assert.ok(
                    err.code === "ATTACH_RPC_UNAVAILABLE" || err.statusCode === 503,
                    `Expected ATTACH_RPC_UNAVAILABLE/503, got code=${err.code} msg=${err.message}`
                );
                return true;
            }
        );
        assert.equal(linkMediaCalled.length, 0, "linkMedia must NOT be called as fallback");
    });

    it("ATTACH-FC-2: PostgREST PGRST202 message must throw ATTACH_RPC_UNAVAILABLE, never call linkMedia", async () => {
        const linkMediaCalled = [];
        const repo = repoWithClient(makePostgrestMissingFunctionClient("attach_workflow_reference_media"));
        const origLink = repo.linkMedia.bind(repo);
        repo.linkMedia = async (...args) => {
            linkMediaCalled.push(args);
            return origLink(...args);
        };

        await assert.rejects(
            () => repo.attachReferenceMedia({ workflowId: "wf-2", mediaId: "m-2" }),
            (err) => {
                assert.ok(
                    err.code === "ATTACH_RPC_UNAVAILABLE" || err.statusCode === 503,
                    `Expected ATTACH_RPC_UNAVAILABLE/503, got code=${err.code} msg=${err.message}`
                );
                return true;
            }
        );
        assert.equal(linkMediaCalled.length, 0, "linkMedia must NOT be called as fallback");
    });

    it("ATTACH-FC-3: client.rpc is absent (no rpc function) must throw ATTACH_RPC_UNAVAILABLE", async () => {
        const client = {
            from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
            // rpc deliberately omitted
        };
        const repo = repoWithClient(client);

        await assert.rejects(
            () => repo.attachReferenceMedia({ workflowId: "wf-3", mediaId: "m-3" }),
            (err) => {
                assert.ok(
                    err.code === "ATTACH_RPC_UNAVAILABLE" || err.statusCode === 503,
                    `Expected ATTACH_RPC_UNAVAILABLE/503, got code=${err.code} msg=${err.message}`
                );
                return true;
            }
        );
    });

    it("ATTACH-FC-4: unrelated schema error (42703) must propagate, not be treated as missing RPC", async () => {
        const repo = repoWithClient(makeUnrelatedSchemaErrorClient("attach_workflow_reference_media"));

        await assert.rejects(
            () => repo.attachReferenceMedia({ workflowId: "wf-4", mediaId: "m-4" }),
            (err) => {
                assert.equal(err.code, "42703", `Expected 42703 to propagate, got ${err.code}: ${err.message}`);
                return true;
            }
        );
    });

    it("ATTACH-FC-5: successful RPC response returns data without calling linkMedia", async () => {
        const linkMediaCalled = [];
        const successClient = {
            from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) }),
            rpc: async (name, params) => {
                if (name === "attach_workflow_reference_media") {
                    return {
                        data: {
                            workflow_id: params.p_workflow_id,
                            media_id: params.p_media_id,
                            role: params.p_role,
                            is_primary: true,
                            current_count: 1,
                            max_allowed: params.p_max_allowed,
                        },
                        error: null,
                    };
                }
                return { data: null, error: null };
            },
        };
        const repo = repoWithClient(successClient);
        const origLink = repo.linkMedia.bind(repo);
        repo.linkMedia = async (...args) => {
            linkMediaCalled.push(args);
            return origLink(...args);
        };

        const result = await repo.attachReferenceMedia({ workflowId: "wf-5", mediaId: "m-5", role: "detail" });
        assert.ok(result, "Should return RPC result");
        assert.equal(result.workflow_id, "wf-5");
        assert.equal(linkMediaCalled.length, 0, "linkMedia must NOT be called on RPC success");
    });
});

describe("ElementMediaService.addReferenceMedia — uses attachReferenceMedia for existing-media attach", () => {
    /**
     * When addReferenceMedia is called with a `mediaId` (attach-existing path),
     * it must route through attachReferenceMedia, not createMediaInWorkflow/linkMedia.
     * This ensures the FOR KEY SHARE lock is acquired on the media row.
     */

    it("ATTACH-WIRE-1: attach-existing path calls attachReferenceMedia, not linkMedia", async () => {
        const { ElementMediaService } = await import("../../src/domain/element/ElementMediaService.js");

        const attachCalled = [];
        const linkCalled = [];

        const wfId = "wf-element-wire-1";
        const mediaId = "existing-media-1";
        const elementId = "00000000-0000-0000-0000-000000000099";

        const mockWorkflowMedia = {
            findByWorkflow: async () => [],
            attachReferenceMedia: async (params) => {
                attachCalled.push(params);
                return { workflow_id: wfId, media_id: mediaId, role: "detail", is_primary: true };
            },
            linkMedia: async (params) => {
                linkCalled.push(params);
                return { workflow_id: wfId, media_id: mediaId, role: "detail" };
            },
            setPrimaryMediaIfNone: async () => true,
            countLinksForMedia: async () => 1,
        };

        const mockDb = {
            elements: {
                resolveRecord: async () => ({ id: elementId, workflow_id: wfId, project_id: "proj-1" }),
            },
            workflowMedia: mockWorkflowMedia,
            media: {
                findById: async () => ({ id: mediaId, url: "https://storage.local/m.png", step_id: "upload" }),
                createMedia: async () => { throw new Error("createMedia must not be called for existing mediaId attach"); },
            },
            workflows: {
                findById: async () => ({ id: wfId, project_id: "proj-1" }),
                updatePrimaryMedia: async () => {},
            },
        };

        const service = new ElementMediaService({
            db: mockDb,
            storageService: {},
            mediaUploadService: { upload: async () => ({ files: [], uploaded: [] }), discard: async () => ({}) },
            workflowMediaService: {
                attachMediaItems: async ({ workflowId, items, role, maxAllowed }) => {
                    for (const item of items) {
                        await mockWorkflowMedia.attachReferenceMedia({
                            workflowId,
                            mediaId: item.mediaId,
                            role,
                            maxAllowed,
                        });
                    }
                    return { attached: items.map(it => ({ media: { id: it.mediaId }, is_primary: false })) };
                },
            },
            authService: { verifyWorkflowOwnership: async () => true },
        });
        // _resolveSourceMedia must return the source media
        service._resolveSourceMedia = async () => ({ id: mediaId, url: "https://storage.local/m.png", step_id: "upload" });
        service._determineShouldBePrimary = async () => false;
        service.setCoverIfNone = async () => false;

        await service.addReferenceMedia({ elementId, mediaId, userId: "user-1", projectId: "proj-1" });

        assert.ok(attachCalled.length > 0, "attachReferenceMedia must be called for the existing-media attach path");
        assert.equal(linkCalled.length, 0, "linkMedia must NOT be called directly by addReferenceMedia");
        assert.equal(attachCalled[0].mediaId, mediaId);
        assert.equal(attachCalled[0].workflowId, wfId);
    });

    it("ATTACH-WIRE-2: attach-existing path with RPC unavailable fails with 503, not a silent link", async () => {
        const { ElementMediaService } = await import("../../src/domain/element/ElementMediaService.js");

        const wfId = "wf-element-wire-2";
        const mediaId = "existing-media-2";
        const elementId = "00000000-0000-0000-0000-000000000098";

        const mockWorkflowMedia = {
            findByWorkflow: async () => [],
            attachReferenceMedia: async () => {
                const err = new Error("Atomic attach RPC unavailable");
                err.code = "ATTACH_RPC_UNAVAILABLE";
                err.statusCode = 503;
                throw err;
            },
            linkMedia: async () => {
                throw new Error("linkMedia must NOT be called when attachReferenceMedia fails closed");
            },
        };

        const mockDb = {
            elements: {
                resolveRecord: async () => ({ id: elementId, workflow_id: wfId, project_id: "proj-1" }),
            },
            workflowMedia: mockWorkflowMedia,
            media: { findById: async () => ({ id: mediaId, url: "https://storage.local/m.png", step_id: "upload" }) },
            workflows: { findById: async () => ({ id: wfId }), updatePrimaryMedia: async () => {} },
        };

        const service = new ElementMediaService({
            db: mockDb,
            storageService: {},
            mediaUploadService: { upload: async () => ({ files: [], uploaded: [] }), discard: async () => ({}) },
            workflowMediaService: {
                attachMediaItems: async ({ workflowId, items, role, maxAllowed }) => {
                    return await mockWorkflowMedia.attachReferenceMedia({
                        workflowId,
                        mediaId: items[0].mediaId,
                        role,
                        maxAllowed,
                    });
                },
            },
            authService: { verifyWorkflowOwnership: async () => true },
        });
        service._resolveSourceMedia = async () => ({ id: mediaId, url: "https://storage.local/m.png", step_id: "upload" });
        service._determineShouldBePrimary = async () => false;
        service.setCoverIfNone = async () => false;

        await assert.rejects(
            () => service.addReferenceMedia({ elementId, mediaId, userId: "user-1", projectId: "proj-1" }),
            (err) => {
                assert.ok(
                    err.statusCode === 503 || err.code === "ATTACH_RPC_UNAVAILABLE" || err.errorCode === "SERVICE_UNAVAILABLE",
                    `Expected 503/ATTACH_RPC_UNAVAILABLE, got ${err.code}: ${err.message}`
                );
                return true;
            }
        );
    });
});
