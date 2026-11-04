import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { checkRuleR10, isKnownSystem, LEGACY_NAMESPACES } = require("../../scripts/arch-check.cjs");

describe("Architecture Ratchet Rule R10: Modular Monolith System Boundaries", () => {
    function makeFile(relPath, content) {
        return {
            rel: relPath,
            text: content,
            lines: content.split(/\r?\n/),
        };
    }

    describe("1. General System Seam Resolution", () => {
        it("recognizes storage and any new system name as a system seam", () => {
            assert.equal(isKnownSystem("storage"), true);
            assert.equal(isKnownSystem("workspace"), true);
            assert.equal(isKnownSystem("billing"), true);
            assert.equal(isKnownSystem("arbitrary-new-system"), true);
        });

        it("excludes legacy infrastructure namespaces from system seam checks", () => {
            const expectedLegacy = ["lib", "utils", "db", "queue", "infrastructure", "platform", "domain"];
            for (const ns of expectedLegacy) {
                assert.ok(LEGACY_NAMESPACES.has(ns), `Missing legacy namespace: ${ns}`);
                assert.equal(isKnownSystem(ns), false, `Legacy namespace ${ns} should not be treated as a system`);
            }
        });
    });

    describe("2. Allowed / Passing Imports (0 Violations)", () => {
        it("allows external controller to import system public API via alias #workspace", () => {
            const file = makeFile(
                "src/controllers/workspaceController.js",
                `import { createWorkspace, getWorkspace } from "#workspace";\n`
            );
            const hits = checkRuleR10(file);
            assert.equal(hits.length, 0);
        });

        it("allows external controller to import system public API via alias #storage", () => {
            const file = makeFile(
                "src/controllers/mediaController.js",
                `import { uploadFile } from "#storage";\n`
            );
            const hits = checkRuleR10(file);
            assert.equal(hits.length, 0);
        });

        it("allows external controller to import system public API via #workspace/index.js", () => {
            const file = makeFile(
                "src/controllers/workspaceController.js",
                `import { createWorkspace } from "#workspace/index.js";\n`
            );
            const hits = checkRuleR10(file);
            assert.equal(hits.length, 0);
        });

        it("allows external route to import system public API via relative path ../systems/workspace/index.js", () => {
            const file = makeFile(
                "src/routes/workspaceRoutes.js",
                `const workspace = require("../systems/workspace/index.js");\n`
            );
            const hits = checkRuleR10(file);
            assert.equal(hits.length, 0);
        });

        it("allows external route to import storage public API via relative path ../systems/storage/index.js", () => {
            const file = makeFile(
                "src/routes/mediaRoutes.js",
                `const storage = require("../systems/storage/index.js");\n`
            );
            const hits = checkRuleR10(file);
            assert.equal(hits.length, 0);
        });

        it("allows external route to import any new system public API via relative path ../systems/any-new-system", () => {
            const file = makeFile(
                "src/routes/newRoutes.js",
                `const newSys = require("../systems/any-new-system");\n`
            );
            const hits = checkRuleR10(file);
            assert.equal(hits.length, 0);
        });

        it("allows internal relative imports within the same system", () => {
            const file = makeFile(
                "src/systems/workspace/services/folderService.js",
                `import { FolderRepo } from "../repositories/folderRepo.js";\n` +
                `import { sanitizeName } from "./helpers.js";\n`
            );
            const hits = checkRuleR10(file);
            assert.equal(hits.length, 0);
        });

        it("allows cross-system call to another system's public API alias #billing", () => {
            const file = makeFile(
                "src/systems/identity/services/userService.js",
                `import { ensureWallet } from "#billing";\n`
            );
            const hits = checkRuleR10(file);
            assert.equal(hits.length, 0);
        });

        it("ignores commented-out deep imports", () => {
            const file = makeFile(
                "src/controllers/workspaceController.js",
                `// const FolderService = require("#workspace/services/FolderService.js");\n` +
                `/* import { FolderService } from "../systems/workspace/services/FolderService.js"; */\n`
            );
            const hits = checkRuleR10(file);
            assert.equal(hits.length, 0);
        });

        it("ignores standard non-system package imports and legacy aliases", () => {
            const file = makeFile(
                "src/controllers/testController.js",
                `import express from "express";\n` +
                `import { logger } from "#utils/logger.js";\n` +
                `import { AppError } from "../errors/AppError.js";\n`
            );
            const hits = checkRuleR10(file);
            assert.equal(hits.length, 0);
        });
    });

    describe("3. Forbidden Deep Imports (Must Fail)", () => {
        it("flags require() of internal file via alias #workspace/services/folderService.js", () => {
            const file = makeFile(
                "src/controllers/workspaceController.js",
                `const FolderService = require("#workspace/services/folderService.js");\n`
            );
            const hits = checkRuleR10(file);
            assert.equal(hits.length, 1);
            assert.equal(hits[0].line, 1);
            assert.ok(hits[0].text.includes("#workspace/services/folderService.js"));
        });

        it("flags import { ... } from internal file via alias #storage/services/storageService.js", () => {
            const file = makeFile(
                "src/controllers/mediaController.js",
                `import { StorageService } from "#storage/services/storageService.js";\n`
            );
            const hits = checkRuleR10(file);
            assert.equal(hits.length, 1);
            assert.equal(hits[0].line, 1);
            assert.ok(hits[0].text.includes("#storage/services/storageService.js"));
        });

        it("flags export { ... } from internal file via alias for arbitrary new system", () => {
            const file = makeFile(
                "src/controllers/index.js",
                `export { internalThing } from "#arbitrary-new-system/services/internal.js";\n`
            );
            const hits = checkRuleR10(file);
            assert.equal(hits.length, 1);
        });

        it("flags dynamic import() of internal system file", () => {
            const file = makeFile(
                "src/controllers/workspaceController.js",
                `const mod = await import("#workspace/services/folderService.js");\n`
            );
            const hits = checkRuleR10(file);
            assert.equal(hits.length, 1);
        });

        it("flags bare side-effect import of internal system file", () => {
            const file = makeFile(
                "src/controllers/workspaceController.js",
                `import "#workspace/services/init.js";\n`
            );
            const hits = checkRuleR10(file);
            assert.equal(hits.length, 1);
        });

        it("flags external relative deep import into src/systems/workspace/services/folderService.js", () => {
            const file = makeFile(
                "src/controllers/workspaceController.js",
                `import { FolderService } from "../systems/workspace/services/folderService.js";\n`
            );
            const hits = checkRuleR10(file);
            assert.equal(hits.length, 1);
            assert.equal(hits[0].line, 1);
        });

        it("flags external relative deep import into src/systems/storage/services/storageService.js", () => {
            const file = makeFile(
                "src/controllers/mediaController.js",
                `import { StorageService } from "../systems/storage/services/storageService.js";\n`
            );
            const hits = checkRuleR10(file);
            assert.equal(hits.length, 1);
            assert.equal(hits[0].line, 1);
        });

        it("flags external relative deep import into src/systems/any-new-system/services/foo.js", () => {
            const file = makeFile(
                "src/controllers/fooController.js",
                `import { foo } from "../systems/any-new-system/services/foo.js";\n`
            );
            const hits = checkRuleR10(file);
            assert.equal(hits.length, 1);
            assert.equal(hits[0].line, 1);
        });

        it("flags cross-system deep relative import from identity to workspace internals", () => {
            const file = makeFile(
                "src/systems/identity/services/userService.js",
                `import { FolderRepo } from "../../workspace/repositories/folderRepo.js";\n`
            );
            const hits = checkRuleR10(file);
            assert.equal(hits.length, 1);
            assert.equal(hits[0].line, 1);
        });

        it("flags cross-system alias deep import from billing to workspace internals", () => {
            const file = makeFile(
                "src/systems/billing/services/chargeService.js",
                `import { FolderService } from "#workspace/services/folderService.js";\n`
            );
            const hits = checkRuleR10(file);
            assert.equal(hits.length, 1);
        });
    });

    describe("4. Temporary Exceptions via arch-exceptions.json", () => {
        it("suppresses violation when matching an active exception entry", () => {
            const file = makeFile(
                "src/systems/workflow-container/index.js",
                `import { legacyService } from "#workspace/services/internalLegacy.js";\n`
            );
            const customExceptions = [
                {
                    rule: "R10",
                    from: "src/systems/workflow-container/index.js",
                    specifierPattern: "^#workspace/services/internalLegacy\\.js$",
                    adr: "ADR-0020",
                    reason: "Temporary Facade-First test hook",
                    eliminateInPhase: "Phase 7",
                },
            ];

            const hits = checkRuleR10(file, customExceptions);
            assert.equal(hits.length, 0, "Exception should have suppressed violation");
        });

        it("does NOT suppress violation if caller file does not match exception 'from'", () => {
            const unauthorizedFile = makeFile(
                "src/controllers/unauthorizedController.js",
                `import { legacyService } from "#workspace/services/internalLegacy.js";\n`
            );
            const customExceptions = [
                {
                    rule: "R10",
                    from: "src/systems/workflow-container/index.js",
                    specifierPattern: "^#workspace/services/internalLegacy\\.js$",
                    adr: "ADR-0020",
                },
            ];

            const hits = checkRuleR10(unauthorizedFile, customExceptions);
            assert.equal(hits.length, 1, "Non-exempt caller must be flagged");
        });
    });
});
