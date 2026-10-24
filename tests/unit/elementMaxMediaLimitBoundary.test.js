import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { WorkflowMediaRepository } from "../../src/db/WorkflowMediaRepository.js";
import { ElementMediaService } from "../../src/domain/element/ElementMediaService.js";
import { ElementService } from "../../src/domain/element/ElementService.js";
import { createPreUploadElementCapacityGuard } from "../../src/middleware/elementUploadGuard.js";
import { CrudServiceError } from "../../src/utils/crudOperationLog.js";

describe("Element Maximum 6 Reference Media Boundary & Enforcement", () => {
    let repo;
    let mediaStore;
    let elementsStore;
    let mockDb;
    let mediaService;
    let elementService;

    const ELEMENT_ID = "00000000-0000-0000-0000-000000000001";
    const WORKFLOW_ID = "wf-limit-test-1";
    const PROJECT_ID = "proj-limit-1";

    beforeEach(() => {
        WorkflowMediaRepository.enableTestMemoryFallback();
        WorkflowMediaRepository.clearMemory();

        repo = new WorkflowMediaRepository();
        mediaStore = [];
        elementsStore = [
            {
                id: ELEMENT_ID,
                workflow_id: WORKFLOW_ID,
                project_id: PROJECT_ID,
                name: "Limited Relic",
                description: "An element that can hold at most 6 reference images",
                create_time: new Date().toISOString(),
            },
        ];

        mockDb = {
            elements: {
                resolveRecord: async (id) => elementsStore.find((e) => e.id === id || e.workflow_id === id) || null,
                findById: async (id) => elementsStore.find((e) => e.id === id) || null,
                list: async ({ projectId }) => elementsStore.filter((e) => !projectId || e.project_id === projectId),
            },
            workflows: {
                findById: async (id) => ({ id, name: id }),
                getPrimaryMediaUrl: async (workflowId) => {
                    const primary = await repo.getPrimaryMedia(workflowId);
                    if (!primary) return null;
                    const m = mediaStore.find((item) => item.id === primary.media_id);
                    return m?.url || null;
                },
            },
            media: {
                createMedia: async (payload) => {
                    const row = { id: `m-${mediaStore.length + 1}`, status: "completed", ...payload };
                    mediaStore.push(row);
                    return row;
                },
                findById: async (id) => mediaStore.find((item) => item.id === id) || null,
                findByWorkflow: async (workflowId) => {
                    const links = await repo.findByWorkflow(workflowId);
                    return links.map((link) => {
                        const m = mediaStore.find((item) => item.id === link.media_id);
                        return {
                            ...(m || {}),
                            id: link.media_id,
                            role: link.role,
                            is_primary: link.is_primary,
                        };
                    });
                },
            },
            workflowMedia: repo,
        };

        const mockUploadService = {
            upload: async ({ files, policy, userId }) => {
                const uploaded = files.map((f, idx) => {
                    const row = {
                        id: `m-${mediaStore.length + 1}`,
                        status: "completed",
                        url: typeof f === "string" ? f : `https://example.com/upload-${idx + 1}.png`,
                        storageKey: `${userId}/${policy?.storageFolder || "element-references"}/upload-${idx + 1}.png`,
                        step_id: "upload",
                    };
                    mediaStore.push(row);
                    return row;
                });
                return { uploaded, files: uploaded };
            },
            discard: async () => {},
        };

        let attachMutex = Promise.resolve();
        const mockWorkflowMediaService = {
            attachMediaItems: async ({ workflowId, projectId, userId, role = "detail", maxAllowed = 6, items = [] }) => {
                const release = attachMutex;
                let nextResolve;
                attachMutex = new Promise((resolve) => { nextResolve = resolve; });
                await release;
                try {
                    const currentCount = (await repo.findByWorkflow(workflowId)).filter((l) => !l.role || l.role === "detail").length;
                    if (maxAllowed !== null && currentCount + items.length > maxAllowed) {
                        throw new CrudServiceError(`Maximum ${maxAllowed} reference images allowed per element`, {
                            statusCode: 400,
                            errorCode: "LIMIT_EXCEEDED",
                        });
                    }
                    const attached = [];
                    for (const item of items) {
                        const mId = item.kind === "existing" ? item.mediaId : item.uploadedFile.id;
                        const mediaRow = mediaStore.find((m) => m.id === mId) || { id: mId, url: item.uploadedFile?.url };
                        const link = await repo.linkMedia({
                            workflowId,
                            mediaId: mId,
                            role,
                            stepId: "upload",
                            is_primary: false,
                        });
                        attached.push({
                            kind: item.kind,
                            media: mediaRow,
                            link,
                        });
                    }
                    return { attached };
                } finally {
                    nextResolve();
                }
            },
        };

        const mockAuthService = {
            verifyWorkflowOwnership: async (wfId, uId) => {
                const elem = elementsStore.find((e) => e.workflow_id === wfId || e.id === wfId);
                if (elem?.user_id && elem.user_id !== uId) return false;
                return true;
            },
        };

        mediaService = new ElementMediaService({
            db: mockDb,
            storageService: {},
            mediaUploadService: mockUploadService,
            workflowMediaService: mockWorkflowMediaService,
            authService: mockAuthService,
        });
        elementService = new ElementService({ db: mockDb, mediaService });
    });

    it("1. Allows adding up to 6 reference images, but rejects the 7th image with 400 LIMIT_EXCEEDED", async () => {
        // Add 6 reference images
        for (let i = 1; i <= 6; i++) {
            const res = await mediaService.addReferenceMedia({
                elementId: ELEMENT_ID,
                imageUrl: `https://example.com/ref-${i}.png`,
                userId: "user-limit",
            });
            assert.equal(res.ok, true, `Image ${i} should be successfully added`);
        }

        const linkedBefore = await repo.findByWorkflow(WORKFLOW_ID);
        assert.equal(linkedBefore.length, 6, "Element should have exactly 6 reference images");

        // Attempting to add the 7th image MUST fail with 400 LIMIT_EXCEEDED
        await assert.rejects(
            async () => {
                await mediaService.addReferenceMedia({
                    elementId: ELEMENT_ID,
                    imageUrl: "https://example.com/ref-7.png",
                    userId: "user-limit",
                });
            },
            (err) => {
                assert.equal(err.statusCode, 400, "Should return HTTP 400");
                assert.equal(err.errorCode, "LIMIT_EXCEEDED", "Error code should be LIMIT_EXCEEDED");
                assert.match(err.message, /Maximum 6 reference images allowed/i);
                return true;
            }
        );

        // Verify count remains strictly 6 in repository
        const linkedAfter = await repo.findByWorkflow(WORKFLOW_ID);
        assert.equal(linkedAfter.length, 6, "Count must remain 6; 7th image must not be inserted");
    });

    it("1b. Quota default regression: the 7th existing mediaId attached to an Element is rejected (LIMIT_EXCEEDED / QuotaError)", async () => {
        const SOURCE_WF_ID = "wf-source-existing";
        elementsStore.push({
            id: SOURCE_WF_ID,
            workflow_id: SOURCE_WF_ID,
            project_id: PROJECT_ID,
            user_id: "user-limit",
        });

        // Pre-populate 6 existing media items linked to SOURCE_WF_ID, then attach them to ELEMENT_ID
        for (let i = 1; i <= 6; i++) {
            const m = {
                id: `m-existing-${i}`,
                status: "completed",
                url: `https://example.com/existing-${i}.png`,
                user_id: "user-limit",
                project_id: PROJECT_ID,
            };
            mediaStore.push(m);
            // Link media to source workflow first
            await repo.attachReferenceMedia({
                workflowId: SOURCE_WF_ID,
                mediaId: m.id,
                role: "output",
                maxAllowed: null,
            });

            // Attach existing media to Element
            const res = await mediaService.addReferenceMedia({
                elementId: ELEMENT_ID,
                mediaId: m.id,
                userId: "user-limit",
                projectId: PROJECT_ID,
            });
            assert.equal(res.ok, true, `Existing media ${i} should attach successfully`);
        }

        const linkedBefore = await repo.findByWorkflow(WORKFLOW_ID);
        assert.equal(linkedBefore.length, 6, "Element should have exactly 6 reference media links");

        // Prepare the 7th existing media item
        const m7 = {
            id: "m-existing-7",
            status: "completed",
            url: "https://example.com/existing-7.png",
            user_id: "user-limit",
            project_id: PROJECT_ID,
        };
        mediaStore.push(m7);
        await repo.attachReferenceMedia({
            workflowId: SOURCE_WF_ID,
            mediaId: m7.id,
            role: "output",
            maxAllowed: null,
        });

        // Attempting to attach the 7th existing mediaId MUST fail through the real ElementMediaService path
        await assert.rejects(
            async () => {
                await mediaService.addReferenceMedia({
                    elementId: ELEMENT_ID,
                    mediaId: m7.id,
                    userId: "user-limit",
                    projectId: PROJECT_ID,
                });
            },
            (err) => {
                assert.equal(err.statusCode, 400, "Should return HTTP 400");
                assert.equal(err.errorCode, "LIMIT_EXCEEDED", "Error code should be LIMIT_EXCEEDED");
                assert.match(err.message, /Maximum 6 reference images allowed/i);
                return true;
            }
        );

        // Verify count remains strictly 6 in repository; 7th existing media was NOT linked
        const linkedAfter = await repo.findByWorkflow(WORKFLOW_ID);
        assert.equal(linkedAfter.length, 6, "Count must remain strictly 6; 7th existing mediaId must not be linked");
    });

    it("2. Removing an image when at 6 allows adding a new 6th image again", async () => {
        const addedIds = [];
        for (let i = 1; i <= 6; i++) {
            const res = await mediaService.addReferenceMedia({
                elementId: ELEMENT_ID,
                imageUrl: `https://example.com/ref-${i}.png`,
                userId: "user-limit",
            });
            addedIds.push(res.media.id);
        }

        // Delete one reference image (e.g. the 2nd one)
        await mediaService.removeReferenceMedia({
            elementId: ELEMENT_ID,
            mediaId: addedIds[1],
            userId: "user-limit",
        });

        const afterDelete = await repo.findByWorkflow(WORKFLOW_ID);
        assert.equal(afterDelete.length, 5, "Count should be 5 after removing one");

        // Now adding another image should succeed
        const res = await mediaService.addReferenceMedia({
            elementId: ELEMENT_ID,
            imageUrl: "https://example.com/ref-replacement.png",
            userId: "user-limit",
        });
        assert.equal(res.ok, true);

        const afterReAdd = await repo.findByWorkflow(WORKFLOW_ID);
        assert.equal(afterReAdd.length, 6, "Count should be back to 6");
    });

    it("3. ingestElementSources rejects payloads with more than 6 source images", async () => {
        const sevenImages = [
            "https://example.com/1.png",
            "https://example.com/2.png",
            "https://example.com/3.png",
            "https://example.com/4.png",
            "https://example.com/5.png",
            "https://example.com/6.png",
            "https://example.com/7.png",
        ];

        await assert.rejects(
            async () => {
                await mediaService.ingestElementSources({
                    workflowId: WORKFLOW_ID,
                    sourceImages: sevenImages,
                    projectId: PROJECT_ID,
                    userId: "user-limit",
                });
            },
            (err) => {
                assert.equal(err.statusCode, 400);
                assert.equal(err.errorCode, "LIMIT_EXCEEDED");
                assert.match(err.message, /Maximum 6 reference images allowed/i);
                return true;
            }
        );
    });

    it("4. assertUploadAllowed passes when slots remain, providing accurate capacity metrics", async () => {
        // Initially 0 images attached
        const capacity = await mediaService.assertUploadAllowed({
            elementId: ELEMENT_ID,
            userId: "user-limit",
        });

        assert.equal(capacity.allowed, true);
        assert.equal(capacity.currentCount, 0);
        assert.equal(capacity.maxAllowed, 6);
        assert.equal(capacity.remainingSlots, 6);
        assert.equal(capacity.workflowId, WORKFLOW_ID);
    });

    it("5. assertUploadAllowed rejects with 400 LIMIT_EXCEEDED before upload when element is full", async () => {
        for (let i = 1; i <= 6; i++) {
            await mediaService.addReferenceMedia({
                elementId: ELEMENT_ID,
                imageUrl: `https://example.com/img-${i}.png`,
                userId: "user-limit",
            });
        }

        await assert.rejects(
            async () => {
                await mediaService.assertUploadAllowed({
                    elementId: ELEMENT_ID,
                    userId: "user-limit",
                });
            },
            (err) => {
                assert.equal(err.statusCode, 400);
                assert.equal(err.errorCode, "LIMIT_EXCEEDED");
                assert.match(err.message, /Maximum 6 reference images allowed/i);
                assert.equal(err.details?.currentCount, 6);
                assert.equal(err.details?.remainingSlots, 0);
                return true;
            }
        );
    });

    it("6. assertUploadAllowed returns 404 for cross-tenant access to prevent enumeration", async () => {
        // Element belongs to user-limit; another user tries to upload
        elementsStore[0].user_id = "user-limit";

        await assert.rejects(
            async () => {
                await mediaService.assertUploadAllowed({
                    elementId: ELEMENT_ID,
                    userId: "attacker-user-id",
                });
            },
            (err) => {
                assert.equal(err.statusCode, 404, "Cross-tenant access must return 404");
                assert.equal(err.errorCode, "NOT_FOUND");
                return true;
            }
        );
    });

    it("7. Respects dynamic ELEMENT_MAX_MEDIA from process.env", async () => {
        const origEnv = process.env.ELEMENT_MAX_MEDIA;
        process.env.ELEMENT_MAX_MEDIA = "3";

        try {
            // Add 3 images
            for (let i = 1; i <= 3; i++) {
                await mediaService.addReferenceMedia({
                    elementId: ELEMENT_ID,
                    imageUrl: `https://example.com/dyn-${i}.png`,
                    userId: "user-limit",
                });
            }

            // 4th image must be rejected at the 3 limit
            await assert.rejects(
                async () => {
                    await mediaService.assertUploadAllowed({
                        elementId: ELEMENT_ID,
                        userId: "user-limit",
                    });
                },
                (err) => {
                    assert.equal(err.statusCode, 400);
                    assert.equal(err.errorCode, "LIMIT_EXCEEDED");
                    assert.match(err.message, /Maximum 3 reference images allowed/i);
                    assert.equal(err.details?.maxAllowed, 3);
                    return true;
                }
            );
        } finally {
            if (origEnv !== undefined) {
                process.env.ELEMENT_MAX_MEDIA = origEnv;
            } else {
                delete process.env.ELEMENT_MAX_MEDIA;
            }
        }
    });

    it("8. Protects against concurrent uploads: simultaneous additions at max-1 allow only one to succeed", async () => {
        // Fill 5 slots out of 6
        for (let i = 1; i <= 5; i++) {
            await mediaService.addReferenceMedia({
                elementId: ELEMENT_ID,
                imageUrl: `https://example.com/concurrent-base-${i}.png`,
                userId: "user-limit",
            });
        }

        const beforeConcurrent = await repo.findByWorkflow(WORKFLOW_ID);
        assert.equal(beforeConcurrent.length, 5);

        // Fire 2 simultaneous uploads targeting the remaining 1 slot
        const results = await Promise.allSettled([
            mediaService.addReferenceMedia({
                elementId: ELEMENT_ID,
                imageUrl: "https://example.com/race-1.png",
                userId: "user-limit",
            }),
            mediaService.addReferenceMedia({
                elementId: ELEMENT_ID,
                imageUrl: "https://example.com/race-2.png",
                userId: "user-limit",
            }),
        ]);

        const fulfilled = results.filter((r) => r.status === "fulfilled");
        const rejected = results.filter((r) => r.status === "rejected");

        assert.equal(fulfilled.length, 1, "Exactly one concurrent upload must succeed");
        assert.equal(rejected.length, 1, "The second concurrent upload must be rejected");
        assert.equal(rejected[0].reason?.statusCode, 400);
        assert.equal(rejected[0].reason?.errorCode, "LIMIT_EXCEEDED");

        // Verify repository strictly contains 6 items
        const afterConcurrent = await repo.findByWorkflow(WORKFLOW_ID);
        assert.equal(afterConcurrent.length, 6, "Repository must never exceed 6 images under concurrency");
    });

    it("9. preUploadElementCapacityGuard middleware passes next() when element has slots", async () => {
        const guard = createPreUploadElementCapacityGuard(mediaService);
        let nextCalled = false;
        const mockReq = {
            params: { id: ELEMENT_ID },
            user: { id: "user-limit" },
        };
        const mockRes = {
            status: () => mockRes,
            json: () => mockRes,
        };

        await guard(mockReq, mockRes, () => {
            nextCalled = true;
        });

        assert.equal(nextCalled, true, "next() must be called when slots are available");
    });

    it("10. preUploadElementCapacityGuard middleware rejects with 400 and halts pipeline before multer when full", async () => {
        for (let i = 1; i <= 6; i++) {
            await mediaService.addReferenceMedia({
                elementId: ELEMENT_ID,
                imageUrl: `https://example.com/guard-${i}.png`,
                userId: "user-limit",
            });
        }

        const guard = createPreUploadElementCapacityGuard(mediaService);
        let nextCalled = false;
        let responseStatus = null;
        let responseJson = null;

        const mockReq = {
            params: { id: ELEMENT_ID },
            user: { id: "user-limit" },
        };
        const mockRes = {
            status: (code) => {
                responseStatus = code;
                return mockRes;
            },
            json: (body) => {
                responseJson = body;
                return mockRes;
            },
        };

        await guard(mockReq, mockRes, () => {
            nextCalled = true;
        });

        assert.equal(nextCalled, false, "next() MUST NOT be called when limit is exceeded (protecting Multer)");
        assert.equal(responseStatus, 400, "Response status must be 400");
        assert.equal(responseJson.code, "LIMIT_EXCEEDED");
        assert.match(responseJson.message, /Maximum 6 reference images allowed/i);
    });

    it("11. preUploadElementCapacityGuard middleware returns 404 for cross-tenant access without calling next()", async () => {
        elementsStore[0].user_id = "user-limit";

        const guard = createPreUploadElementCapacityGuard(mediaService);
        let nextCalled = false;
        let responseStatus = null;

        const mockReq = {
            params: { id: ELEMENT_ID },
            user: { id: "attacker-user" },
        };
        const mockRes = {
            status: (code) => {
                responseStatus = code;
                return mockRes;
            },
            json: () => mockRes,
        };

        await guard(mockReq, mockRes, () => {
            nextCalled = true;
        });

        assert.equal(nextCalled, false, "next() must not be called on unauthorized upload");
        assert.equal(responseStatus, 404, "Cross-tenant access must return 404 before file stream");
    });

    it("12. preUploadElementCapacityGuard ignores req.body.userId and rejects unauthenticated request with 401", async () => {
        const guard = createPreUploadElementCapacityGuard(mediaService);
        let nextCalled = false;
        let responseStatus = null;
        let responseJson = null;

        const mockReq = {
            params: { id: ELEMENT_ID },
            body: { userId: "user-limit" },
            user: null,
        };
        const mockRes = {
            status: (code) => {
                responseStatus = code;
                return mockRes;
            },
            json: (body) => {
                responseJson = body;
                return mockRes;
            },
        };

        await guard(mockReq, mockRes, () => {
            nextCalled = true;
        });

        assert.equal(nextCalled, false, "next() must not be called when unauthenticated");
        assert.equal(responseStatus, 401, "Must reject with 401 UNAUTHORIZED");
        assert.equal(responseJson.code, "UNAUTHORIZED");
    });
});
