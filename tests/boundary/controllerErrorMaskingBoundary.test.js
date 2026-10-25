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
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { characterService, trashService } from "../../src/container.js";
import {
    createCharacter,
    generateCharacterSheet,
    generateCharacterDescription,
    updateCharacter,
    deleteCharacter,
    addMediaToCharacter,
    removeMediaFromCharacter,
    setCharacterSheetMedia,
    uploadCharacterMedia,
} from "../../controllers/characterController.js";
import { safePublicRouteError } from "../../src/utils/safePublicRouteError.js";

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
