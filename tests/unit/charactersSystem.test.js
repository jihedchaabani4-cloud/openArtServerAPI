import { describe, it, before } from "node:test";
import assert from "node:assert/strict";

import {
    getCharacterPromptContext,
    validateCharacterExists,
    attachCharacterSheetResult,
    characterRepository,
    CharacterRepository,
    CharacterService,
    CharacterMediaService,
    CharacterGenerationService,
    CHARACTER_MAX_DETAIL_MEDIA,
    CharactersError,
    CharactersValidationError,
    CharactersNotFoundError,
    CharactersConflictError,
    CharactersUnauthorizedError,
} from "#characters/tools";

import charactersRouter from "#characters/api";

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
