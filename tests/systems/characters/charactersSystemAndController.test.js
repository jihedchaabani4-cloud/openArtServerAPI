import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { getCharacterPromptContext, validateCharacterExists, attachCharacterSheetResult, characterRepository, CharacterRepository, CharacterService, CharacterMediaService, CharacterGenerationService, CHARACTER_MAX_DETAIL_MEDIA, CharactersError, CharactersValidationError, CharactersNotFoundError, CharactersConflictError, CharactersUnauthorizedError } from "#characters/tools";
import charactersRouter, { createCharacter, generateCharacterSheet, generateCharacterDescription, updateCharacter, deleteCharacter, addMediaToCharacter, removeMediaFromCharacter, setCharacterSheetMedia, uploadCharacterMedia } from "#characters/api";
import { characterService, trashService } from "../../../src/container.js";
import { safePublicRouteError } from "#shared";
import { randomUUID } from "node:crypto";
import { WorkflowMediaService } from "../../../src/systems/generation/internal/services/WorkflowMediaService.js";

// ─── Source: charactersSystem.test.js ───
{
describe("System 6: Characters (#characters/tools & #characters/api)", () => {
    describe("1. Exported Error Hierarchy", () => {
        it("CharactersError inherits from AppError with 500 status", () => {
            const err = new CharactersError("CHAR_ERR", "Characters system failure");
            assert.equal(err.statusCode, 500);
            assert.equal(err.code, "CHAR_ERR");
        });

        it("CharactersValidationError sets 400 status and field context", () => {
            const err = new CharactersValidationError("Invalid characterId", { field: "characterId" });
            assert.equal(err.statusCode, 400);
            assert.equal(err.field, "characterId");
        });

        it("CharactersNotFoundError sets 404 status and characterId context", () => {
            const err = new CharactersNotFoundError("Character not found", { characterId: "char-123" });
            assert.equal(err.statusCode, 404);
            assert.equal(err.characterId, "char-123");
        });

        it("CharactersConflictError sets 409 status", () => {
            const err = new CharactersConflictError("Character detail limit reached");
            assert.equal(err.statusCode, 409);
        });

        it("CharactersUnauthorizedError sets 403 status", () => {
            const err = new CharactersUnauthorizedError("Access denied", { characterId: "char-123", userId: "user-456" });
            assert.equal(err.statusCode, 403);
        });
    });

    describe("2. Tools Interface (#characters/tools)", () => {
        it("getCharacterPromptContext throws CharactersValidationError if characterId is missing", async () => {
            await assert.rejects(
                async () => getCharacterPromptContext({}),
                (err) => err instanceof CharactersValidationError && err.statusCode === 400
            );
        });

        it("getCharacterPromptContext throws CharactersNotFoundError if character does not exist", async () => {
            // Mock characterRepository.findByCharacterId to return null
            const origFind = characterRepository.findByCharacterId;
            characterRepository.findByCharacterId = async () => null;

            try {
                await assert.rejects(
                    async () => getCharacterPromptContext({ characterId: "nonexistent-char-uuid" }),
                    (err) => err instanceof CharactersNotFoundError && err.statusCode === 404
                );
            } finally {
                characterRepository.findByCharacterId = origFind;
            }
        });

        it("getCharacterPromptContext returns formatted context when character exists", async () => {
            const mockChar = {
                id: "char-uuid-001",
                workflow_id: "wf-uuid-001",
                name: "Aria Thorne",
                description: "An ethereal sorceress with silver hair and amethyst eyes.",
                traits: { hair: "silver", eyes: "amethyst", archetype: "sorceress" },
                reference_media_urls: ["https://storage.cdn/aria-1.png", "https://storage.cdn/aria-2.png"],
            };

            const origFind = characterRepository.findByCharacterId;
            characterRepository.findByCharacterId = async () => mockChar;

            try {
                const context = await getCharacterPromptContext({ characterId: "char-uuid-001" });
                assert.equal(context.name, "Aria Thorne");
                assert.equal(context.description, "An ethereal sorceress with silver hair and amethyst eyes.");
                assert.deepEqual(context.traits, { hair: "silver", eyes: "amethyst", archetype: "sorceress" });
                assert.deepEqual(context.referenceMediaUrls, [
                    "https://storage.cdn/aria-1.png",
                    "https://storage.cdn/aria-2.png",
                ]);
            } finally {
                characterRepository.findByCharacterId = origFind;
            }
        });

        it("validateCharacterExists throws CharactersValidationError if characterId is missing", async () => {
            await assert.rejects(
                async () => validateCharacterExists({}),
                (err) => err instanceof CharactersValidationError && err.statusCode === 400
            );
        });

        it("validateCharacterExists returns true when character exists", async () => {
            const origFind = characterRepository.findByCharacterId;
            characterRepository.findByCharacterId = async () => ({ id: "char-001" });

            try {
                const exists = await validateCharacterExists({ characterId: "char-001" });
                assert.equal(exists, true);
            } finally {
                characterRepository.findByCharacterId = origFind;
            }
        });

        it("attachCharacterSheetResult updates character primary_media_id and sheet_url", async () => {
            let capturedId = null;
            let capturedPatch = null;

            const origUpdate = characterRepository.updateCharacterFields;
            characterRepository.updateCharacterFields = async (id, patch) => {
                capturedId = id;
                capturedPatch = patch;
                return { id, ...patch };
            };

            try {
                const result = await attachCharacterSheetResult({
                    characterId: "char-001",
                    mediaId: "media-sheet-001",
                    sheetUrl: "https://storage.cdn/sheet.png",
                });

                assert.equal(capturedId, "char-001");
                assert.equal(capturedPatch.primary_media_id, "media-sheet-001");
                assert.equal(capturedPatch.sheet_url, "https://storage.cdn/sheet.png");
                assert.ok(result);
            } finally {
                characterRepository.updateCharacterFields = origUpdate;
            }
        });

        it("exports service classes and constants", () => {
            assert.ok(CharacterService);
            assert.ok(CharacterMediaService);
            assert.ok(CharacterGenerationService);
            assert.equal(CHARACTER_MAX_DETAIL_MEDIA, 5);
            assert.ok(CharacterRepository);
            assert.ok(characterRepository);
        });
    });

    describe("3. HTTP API Gateway (#characters/api)", () => {
        it("exports an Express router with character routes", () => {
            assert.ok(charactersRouter);
            assert.ok(Array.isArray(charactersRouter.stack));

            const routes = charactersRouter.stack
                .filter((layer) => layer.route)
                .map((layer) => ({
                    path: layer.route.path,
                    methods: Object.keys(layer.route.methods),
                }));

            const paths = routes.map((r) => r.path);
            assert.ok(paths.includes("/create"));
            assert.ok(paths.includes("/"));
            assert.ok(paths.includes("/character"));
            assert.ok(paths.includes("/generate-description"));
            assert.ok(paths.includes("/:characterId"));
            assert.ok(paths.includes("/:characterId/generate-sheet"));
            assert.ok(paths.includes("/:characterId/media"));
            assert.ok(paths.includes("/:characterId/media/:mediaId"));
            assert.ok(paths.includes("/:characterId/sheet-media"));
            assert.ok(paths.includes("/:characterId/upload"));
        });
    });
});
}

// ─── Source: controllerErrorMaskingBoundary.test.js ───
{
/**
 * Boundary tests: direct controller 5xx error masking (character controller).
 *
 * Proves the direct `res.status(...).json({ message: err.message })` catch
 * blocks in controllers/characterController.js never expose internal
 * exception details to clients:
 *   1. Unexpected 5xx errors are masked to the generic public message
 *      "Internal server error" + errorCode INTERNAL_ERROR.
 *   2. Intentional public 4xx messages/errorCodes pass through unchanged
 *      (additive errorCode only).
 *   3. The documented INSUFFICIENT_CREDITS -> 402 contract on
 *      generateCharacterSheet is preserved through the mapping.
 *   4. generateCharacterDescription stays masked (regression guard for the
 *      pre-existing safe handler).
 *
 * Pattern mirrors workflowMediaScopedDeletionBoundary: handlers are invoked
 * directly with fake req/res; the container services are stubbed per test
 * and restored in finally, so no network or real database is touched.
 */

function leakyError() {
    return new Error("connect ECONNREFUSED 10.0.0.4:5432 credential=sk-internal-77");
}

function makeStubThrow(service, method, err) {
    const original = service[method];
    service[method] = async () => { throw err; };
    return () => { service[method] = original; };
}

function fakeRes() {
    return {
        statusCode: null,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(payload) { this.body = payload; return this; },
    };
}

function fakeReq(overrides = {}) {
    return {
        params: {},
        query: {},
        body: {},
        user: { id: "user-1" },
        headers: {},
        ...overrides,
    };
}

describe("Controller 5xx masking boundary (character controller)", () => {
    const maskedCases = [
        { name: "createCharacter", method: "createCharacter", handler: createCharacter, req: { body: { project_id: "proj-1", name: "Character" } } },
        { name: "generateCharacterSheet", method: "generateCharacterSheet", handler: generateCharacterSheet, req: { params: { characterId: "char-1" } } },
        { name: "updateCharacter", method: "updateCharacter", handler: updateCharacter, req: { params: { characterId: "char-1" } } },
        { name: "deleteCharacter", service: trashService, method: "requestDelete", handler: deleteCharacter, req: { params: { characterId: "char-1" } } },
        { name: "addMediaToCharacter", method: "addMediaToCharacter", handler: addMediaToCharacter, req: { params: { characterId: "char-1" }, body: { mediaId: "media-1" } } },
        { name: "removeMediaFromCharacter", method: "removeMediaFromCharacter", handler: removeMediaFromCharacter, req: { params: { characterId: "char-1", mediaId: "media-1" } } },
        { name: "setCharacterSheetMedia", method: "setCharacterSheetMedia", handler: setCharacterSheetMedia, req: { params: { characterId: "char-1" }, body: { mediaId: "media-1" } } },
        { name: "uploadCharacterMedia (sheet default)", method: "setCharacterSheetMedia", handler: uploadCharacterMedia, req: { params: { characterId: "char-1" } } },
        { name: "uploadCharacterMedia (detail)", method: "addMediaToCharacter", handler: uploadCharacterMedia, req: { params: { characterId: "char-1" }, body: { type: "detail" } } },
    ];

    for (const sample of maskedCases) {
        it(`masks internal 5xx details in ${sample.name}`, async () => {
            const err = leakyError();
            const restore = makeStubThrow(sample.service || characterService, sample.method, err);
            try {
                const res = fakeRes();
                await sample.handler(fakeReq(sample.req), res);

                assert.equal(res.statusCode, 500);
                assert.equal(res.body.ok, false);
                assert.equal(res.body.message, "Internal server error");
                assert.equal(res.body.errorCode, "INTERNAL_ERROR");

                const serialized = JSON.stringify(res.body);
                assert.ok(!serialized.includes("ECONNREFUSED"), "must not leak connection details");
                assert.ok(!serialized.includes("sk-internal-77"), "must not leak credential-looking fragments");
            } finally {
                restore();
            }
        });
    }

    it("preserves intentional public 4xx messages and errorCodes", async () => {
        const err = Object.assign(new Error("Character not found"), {
            statusCode: 404,
            errorCode: "CHARACTER_NOT_FOUND",
        });
        const restore = makeStubThrow(trashService, "requestDelete", err);
        try {
            const res = fakeRes();
            await deleteCharacter(fakeReq({ params: { characterId: "char-1" } }), res);

            assert.equal(res.statusCode, 404);
            assert.equal(res.body.ok, false);
            assert.equal(res.body.message, "Character not found");
            assert.equal(res.body.errorCode, "CHARACTER_NOT_FOUND");
        } finally {
            restore();
        }
    });

    it("preserves the INSUFFICIENT_CREDITS -> 402 contract on generateCharacterSheet", async () => {
        const err = Object.assign(new Error("Not enough credits"), { code: "INSUFFICIENT_CREDITS" });
        const restore = makeStubThrow(characterService, "generateCharacterSheet", err);
        try {
            const res = fakeRes();
            await generateCharacterSheet(fakeReq({ params: { characterId: "char-1" } }), res);

            assert.equal(res.statusCode, 402);
            assert.equal(res.body.ok, false);
            assert.equal(res.body.message, "Not enough credits");
            assert.notEqual(res.body.errorCode, "INTERNAL_ERROR");
        } finally {
            restore();
        }
    });

    it("keeps generateCharacterDescription masked on 5xx (regression guard)", async () => {
        const restore = makeStubThrow(characterService, "generateDescription", leakyError());
        try {
            const res = fakeRes();
            await generateCharacterDescription(fakeReq(), res);

            assert.equal(res.statusCode, 500);
            assert.equal(res.body.ok, false);
            assert.equal(res.body.message, "An unexpected error occurred. Please try again later.");
            assert.equal(res.body.code, "INTERNAL_ERROR");

            const serialized = JSON.stringify(res.body);
            assert.ok(!serialized.includes("ECONNREFUSED"), "must not leak connection details");
            assert.ok(!serialized.includes("sk-internal-77"), "must not leak credential-looking fragments");
        } finally {
            restore();
        }
    });
});

describe("safePublicRouteError mapping", () => {
    it("masks 5xx payloads to the generic public contract", () => {
        const mapped = safePublicRouteError(new Error("connect ECONNREFUSED 10.0.0.4:5432"));
        assert.equal(mapped.statusCode, 500);
        assert.equal(mapped.errorCode, "INTERNAL_ERROR");
        assert.equal(mapped.publicMessage, "Internal server error");
    });

    it("keeps 4xx messages with errorCode passthrough and canonical defaults", () => {
        const withCode = safePublicRouteError(Object.assign(new Error("Folder not found"), { errorCode: "FOLDER_NOT_FOUND", statusCode: 404 }));
        assert.equal(withCode.statusCode, 404);
        assert.equal(withCode.errorCode, "FOLDER_NOT_FOUND");
        assert.equal(withCode.publicMessage, "Folder not found");

        const bare = safePublicRouteError(Object.assign(new Error("Input rejected"), { statusCode: 400 }));
        assert.equal(bare.errorCode, "APP_ERROR");
        assert.equal(bare.publicMessage, "Input rejected");
    });

    it("honors an explicit statusCode override (e.g. INSUFFICIENT_CREDITS -> 402)", () => {
        const mapped = safePublicRouteError(new Error("Not enough credits"), { statusCode: 402 });
        assert.equal(mapped.statusCode, 402);
        assert.equal(mapped.errorCode, "APP_ERROR");
        assert.equal(mapped.publicMessage, "Not enough credits");

        const masked = safePublicRouteError(new Error("boom"), { statusCode: 503 });
        assert.equal(masked.statusCode, 503);
        assert.equal(masked.errorCode, "INTERNAL_ERROR");
        assert.equal(masked.publicMessage, "Internal server error");
    });
});
}

// ─── Source: characterSheetAssetBug.test.js ───
{
process.env.NODE_ENV = "test";


function setupBugHarness() {
    const workflows = new Map();
    const media = new Map();
    const workflowMedia = [];
    const characters = new Map();

    const db = {
        workflows: {
            getWorkflow: async (id) => workflows.get(id) || null,
            findById: async (id) => workflows.get(id) || null,
            updatePrimaryMedia: async (wfId, mediaId) => {
                const wf = workflows.get(wfId);
                if (wf) wf.primary_media_id = mediaId;
                return wf;
            },
            updateFields: async (wfId, fields) => {
                const wf = workflows.get(wfId);
                if (wf) Object.assign(wf, fields);
                return wf;
            },
        },
        characters: {
            findByCharacterId: async (id) => characters.get(id) || null,
            findById: async (id) => characters.get(id) || null,
            updateCharacterFields: async (id, fields) => {
                const c = characters.get(id);
                if (c) Object.assign(c, fields);
                return c;
            },
        },
        media: {
            findById: async (id) => media.get(id) || null,
            findMediaByIdOrWorkflow: async (id) => {
                const m = media.get(id);
                if (m) return m;
                // find latest by workflow
                const rels = workflowMedia.filter((wm) => wm.workflow_id === id);
                if (rels.length > 0) {
                    return media.get(rels[rels.length - 1].media_id) || null;
                }
                return null;
            },
            findByWorkflow: async (wfId) => {
                const rels = workflowMedia.filter((wm) => wm.workflow_id === wfId);
                return rels.map((r) => media.get(r.media_id)).filter(Boolean);
            },
            createMedia: async (fields) => {
                const id = fields.id || randomUUID();
                const record = { id, ...fields };
                media.set(id, record);
                return record;
            },
        },
        workflowMedia: {
            findByWorkflow: async (wfId) => workflowMedia.filter((wm) => wm.workflow_id === wfId),
            findByMedia: async (mediaId) => workflowMedia.filter((wm) => wm.media_id === mediaId),
            getPrimaryMedia: async (wfId) => workflowMedia.find((wm) => wm.workflow_id === wfId && wm.is_primary === true) || null,
            attachReferenceMedia: async ({ workflowId, mediaId, role = "sheet", maxAllowed = null, autoPrimary = true }) => {
                const currentRelations = workflowMedia.filter((wm) => wm.workflow_id === workflowId && wm.role === role);
                const existing = currentRelations.find((wm) => wm.media_id === mediaId);
                if (existing) {
                    return { workflow_id: workflowId, media_id: mediaId, role, is_primary: Boolean(existing.is_primary), is_existing: true };
                }
                const is_primary = autoPrimary ? !workflowMedia.some((wm) => wm.workflow_id === workflowId && wm.is_primary === true) : false;
                const link = { workflow_id: workflowId, media_id: mediaId, role, is_primary, created_at: new Date().toISOString() };
                workflowMedia.push(link);
                return { workflow_id: workflowId, media_id: mediaId, role, is_primary, is_existing: false };
            },
            setPrimaryMedia: async ({ workflowId, mediaId }) => {
                for (const wm of workflowMedia) {
                    if (wm.workflow_id === workflowId) {
                        wm.is_primary = wm.media_id === mediaId;
                    }
                }
                return { workflow_id: workflowId, media_id: mediaId, is_primary: true };
            },
        },
    };

    const authService = {
        verifyWorkflowOwnership: async (wfId, userId) => {
            const wf = workflows.get(wfId);
            return wf ? wf.user_id === userId : false;
        },
        verifyMediaOwnership: async (mediaId, userId) => {
            const m = media.get(mediaId);
            return m ? m.user_id === userId : false;
        },
    };

    const mediaUploadService = {
        upload: async () => ({ uploaded: [] }),
        discard: async () => ({}),
    };

    const workflowMediaService = new WorkflowMediaService({
        db,
        storageService: {},
        authService,
        mediaUploadService,
    });

    const characterMediaService = new CharacterMediaService({
        db,
        storageService: {},
        mediaUploadService,
        workflowMediaService,
        authService,
    });

    return {
        workflows,
        media,
        workflowMedia,
        characters,
        characterMediaService,
        workflowMediaService,
    };
}

describe("Character Sheet from Project Assets Reproduction", () => {
    const USER_ID = "user-123";
    const PROJECT_ID = "proj-123";
    const CHAR_WF_ID = "char-wf-001";
    const CHAR_ID = CHAR_WF_ID;

    it("Scenario A: User selects a media asset from a generation workflow (ImportMediaPopover rewrites id to workflow_id)", async () => {
        const h = setupBugHarness();

        // 1. Existing character
        h.workflows.set(CHAR_WF_ID, {
            id: CHAR_WF_ID,
            user_id: USER_ID,
            project_id: PROJECT_ID,
            workflow_type: "CHARACTER",
            primary_media_id: null,
        });
        h.characters.set(CHAR_ID, {
            id: CHAR_ID,
            workflow_id: CHAR_WF_ID,
            project_id: PROJECT_ID,
            user_id: USER_ID,
        });

        // 2. An asset in the project created by an image-gen workflow
        const GEN_WF_ID = "wf-gen-999";
        const MEDIA_ID = "media-img-888";
        h.workflows.set(GEN_WF_ID, {
            id: GEN_WF_ID,
            user_id: USER_ID,
            project_id: PROJECT_ID,
            workflow_type: "GENERATED",
            primary_media_id: MEDIA_ID,
        });
        h.media.set(MEDIA_ID, {
            id: MEDIA_ID,
            project_id: PROJECT_ID,
            url: "https://storage.example.com/gen.png",
            status: "success",
        });
        h.workflowMedia.push({
            workflow_id: GEN_WF_ID,
            media_id: MEDIA_ID,
            role: "output",
            is_primary: true,
        });

        // What ImportMediaPopover produces when user selects this asset:
        // canonicalWorkflowId = item.workflow_id -> GEN_WF_ID
        // asset.id = GEN_WF_ID
        // useCharacter selects mediaId = GEN_WF_ID (or item.id)
        // And calls CharacterMediaService.uploadSheetMedia({ characterId: CHAR_ID, mediaId: GEN_WF_ID, projectId: PROJECT_ID, userId: USER_ID })
        const res = await h.characterMediaService.uploadSheetMedia({
            characterId: CHAR_ID,
            mediaId: GEN_WF_ID,
            projectId: PROJECT_ID,
            userId: USER_ID,
        });

        assert.equal(res.ok, true);
        assert.equal(res.media.id, MEDIA_ID);
        assert.equal(res.url, "https://storage.example.com/gen.png");
    });

    it("Scenario B: User selects an uploaded project asset (role: original in workflow_media)", async () => {
        const h = setupBugHarness();

        // Existing character
        h.workflows.set(CHAR_WF_ID, {
            id: CHAR_WF_ID,
            user_id: USER_ID,
            project_id: PROJECT_ID,
            workflow_type: "CHARACTER",
            primary_media_id: null,
        });
        h.characters.set(CHAR_ID, {
            id: CHAR_ID,
            workflow_id: CHAR_WF_ID,
            project_id: PROJECT_ID,
            user_id: USER_ID,
        });

        // Uploaded project media (e.g. uploaded directly to project or imported)
        const UPLOAD_WF_ID = "wf-upload-777";
        const UPLOAD_MEDIA_ID = "media-upload-777";
        h.workflows.set(UPLOAD_WF_ID, {
            id: UPLOAD_WF_ID,
            user_id: USER_ID,
            project_id: PROJECT_ID,
            workflow_type: "UPLOAD",
            primary_media_id: UPLOAD_MEDIA_ID,
        });
        h.media.set(UPLOAD_MEDIA_ID, {
            id: UPLOAD_MEDIA_ID,
            project_id: PROJECT_ID,
            user_id: USER_ID,
            url: "https://storage.example.com/standalone.png",
            status: "success",
        });
        h.workflowMedia.push({
            workflow_id: UPLOAD_WF_ID,
            media_id: UPLOAD_MEDIA_ID,
            role: "original",
            is_primary: true,
        });

        const res = await h.characterMediaService.uploadSheetMedia({
            characterId: CHAR_ID,
            mediaId: UPLOAD_MEDIA_ID,
            projectId: PROJECT_ID,
            userId: USER_ID,
        });

        assert.equal(res.ok, true);
        assert.equal(res.media.id, UPLOAD_MEDIA_ID);
    });

    it("Scenario C: Legacy character entity in characters table with separate or null workflow_id", async () => {
        const h = setupBugHarness();

        const LEGACY_CHAR_ID = "char-legacy-entity-001";
        const LEGACY_WF_ID = "wf-container-002";

        // Character workflow exists under LEGACY_WF_ID
        h.workflows.set(LEGACY_WF_ID, {
            id: LEGACY_WF_ID,
            user_id: USER_ID,
            project_id: PROJECT_ID,
            workflow_type: "CHARACTER_SHEET",
            primary_media_id: null,
        });
        // Character row has id = LEGACY_CHAR_ID and workflow_id = LEGACY_WF_ID
        h.characters.set(LEGACY_CHAR_ID, {
            id: LEGACY_CHAR_ID,
            workflow_id: LEGACY_WF_ID,
            project_id: PROJECT_ID,
            user_id: USER_ID,
        });

        const MEDIA_ID = "media-img-555";
        const SOURCE_WF_ID = "wf-source-555";
        h.workflows.set(SOURCE_WF_ID, {
            id: SOURCE_WF_ID,
            user_id: USER_ID,
            project_id: PROJECT_ID,
            workflow_type: "UPLOAD",
            primary_media_id: MEDIA_ID,
        });
        h.media.set(MEDIA_ID, {
            id: MEDIA_ID,
            project_id: PROJECT_ID,
            user_id: USER_ID,
            url: "https://storage.example.com/legacy.png",
            status: "success",
        });
        h.workflowMedia.push({
            workflow_id: SOURCE_WF_ID,
            media_id: MEDIA_ID,
            role: "original",
            is_primary: true,
        });

        // uploadSheetMedia is invoked with characterId = LEGACY_CHAR_ID
        const res = await h.characterMediaService.uploadSheetMedia({
            characterId: LEGACY_CHAR_ID,
            mediaId: MEDIA_ID,
            projectId: PROJECT_ID,
            userId: USER_ID,
        });

        assert.equal(res.ok, true);
        assert.equal(res.media.id, MEDIA_ID);
    });
});
}
