import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

// ─── Source: archRuleR10.test.js ───
{
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
}

// ─── Source: archSystemsRules.test.js ───
{
const require = createRequire(import.meta.url);
const {
  checkRuleR10,
  checkRuleR11,
  checkRuleR12,
  checkRuleR13,
  checkRuleR15,
  checkRuleR16,
  checkRuleR18,
  findImportCycles,
  collect,
} = require("../../scripts/arch-check.cjs");

describe("Ticket 0.4 Architecture Rules R10-R16 and Cycle Detector", () => {
  function makeFile(relPath, content) {
    return {
      rel: relPath,
      text: content,
      lines: content.split(/\r?\n/),
    };
  }

  describe("Rule R10: System gateways", () => {
    it("allows public/api and public/tools access", () => {
      const file = makeFile(
        "src/controllers/orderController.js",
        `import { billingTools } from "#billing/tools";\nimport { identityRouter } from "#identity/api";\n`
      );
      const hits = checkRuleR10(file);
      assert.equal(hits.length, 0);
    });

    it("flags deep internal imports from another system", () => {
      const file = makeFile(
        "src/controllers/orderController.js",
        `import { walletRepo } from "#billing/internal/db/walletRepo.js";\n`
      );
      const hits = checkRuleR10(file);
      assert.equal(hits.length, 1);
    });

    it("allows #shared/redis outside workflow-engine and blocks it inside workflow-engine", () => {
      const workerFile = makeFile(
        "src/systems/generation/internal/workers/useCaseWorker.js",
        `import { workerRedisConnection } from "#shared/redis";\n`
      );
      assert.equal(checkRuleR10(workerFile).length, 0);

      const engineFile = makeFile(
        "src/systems/workflow-engine/internal/core/ExecutionEngine.js",
        `import { redisConnection } from "#shared/redis";\n`
      );
      assert.equal(checkRuleR10(engineFile).length, 1);
    });
  });

  describe("Rule R11: Internal cannot import own public gateways", () => {
    it("flags internal file importing its own system public gateway", () => {
      const file = makeFile(
        "src/systems/billing/internal/services/walletService.js",
        `import { billingTools } from "#billing/tools";\n`
      );
      const hits = checkRuleR11(file);
      assert.equal(hits.length, 1);
      assert.ok(hits[0].text.includes("#billing/tools"));
    });

    it("allows internal file importing sibling internal file", () => {
      const file = makeFile(
        "src/systems/billing/internal/services/walletService.js",
        `import { walletRepo } from "../db/walletRepo.js";\n`
      );
      const hits = checkRuleR11(file);
      assert.equal(hits.length, 0);
    });
  });

  describe("Rule R12: DB & SDK client isolation", () => {
    it("flags supabase import outside internal/db/ or internal/storage/", () => {
      const file = makeFile(
        "src/systems/billing/internal/services/walletService.js",
        `import { createClient } from "@supabase/supabase-js";\n`
      );
      const hits = checkRuleR12(file);
      assert.equal(hits.length, 1);
    });

    it("flags supabase import in legacy folders outside src/systems/", () => {
      const file = makeFile(
        "src/domain/project/ProjectService.js",
        `import { supabase } from "#lib/supabase.js";\n`
      );
      const hits = checkRuleR12(file);
      assert.equal(hits.length, 1);
    });

    it("allows supabase import inside internal/db/", () => {
      const file = makeFile(
        "src/systems/billing/internal/db/walletRepo.js",
        `import { createClient } from "@supabase/supabase-js";\n`
      );
      const hits = checkRuleR12(file);
      assert.equal(hits.length, 0);
    });
  });

  describe("Rule R13: Web framework isolation", () => {
    it("flags express in internal services", () => {
      const file = makeFile(
        "src/systems/billing/internal/services/walletService.js",
        `import express from "express";\n`
      );
      const hits = checkRuleR13(file);
      assert.equal(hits.length, 1);
    });

    it("allows express in public/api.js", () => {
      const file = makeFile(
        "src/systems/billing/public/api.js",
        `import express from "express";\n`
      );
      const hits = checkRuleR13(file);
      assert.equal(hits.length, 0);
    });
  });

  describe("Rule R16: Zero outbound legacy imports from src/systems/ or src/shared/", () => {
    it("flags relative outbound imports to legacy src/domain/ or controllers/", () => {
      const file = makeFile(
        "src/systems/workspace/public/tools.js",
        `import { ProjectService } from "../../../domain/project/ProjectService.js";\n`
      );
      const hits = checkRuleR16(file);
      assert.equal(hits.length, 1);
    });

    it("flags legacy #alias imports from src/systems/", () => {
      const file = makeFile(
        "src/systems/identity/internal/services/AuthService.js",
        `const container = await import("#container.js");\n`
      );
      const hits = checkRuleR16(file);
      assert.equal(hits.length, 1);
    });

    it("allows #shared and #system/tools imports inside src/systems/", () => {
      const file = makeFile(
        "src/systems/workspace/internal/services/ProjectService.js",
        `import { createLogger } from "#shared";\nimport { getWalletService } from "#billing/tools";\n`
      );
      const hits = checkRuleR16(file);
      assert.equal(hits.length, 0);
    });
  });

  describe("Rule R14: Cycle detector algorithm", () => {
    it("detects a synthetic 2-file circular dependency", () => {
      const syntheticFiles = [
        makeFile("src/modA.js", `import { b } from "./modB.js";\n`),
        makeFile("src/modB.js", `import { a } from "./modA.js";\n`),
      ];
      const cycles = findImportCycles(syntheticFiles, {});
      assert.equal(cycles.length, 1);
      assert.equal(cycles[0].length, 2);
    });

    it("does not flag acyclic dependencies", () => {
      const syntheticFiles = [
        makeFile("src/modA.js", `import { b } from "./modB.js";\n`),
        makeFile("src/modB.js", `export const b = 42;\n`),
      ];
      const cycles = findImportCycles(syntheticFiles, {});
      assert.equal(cycles.length, 0);
    });

    it("verifies the 3 Partie 00 circular pairs are resolved", () => {
      const { files } = collect();

      // Pair 1: WorkflowExecutor -> circular dependency check (must not import runners)
      const workflowExec = files.find((f) => f.rel === "src/systems/workflow-engine/internal/core/WorkflowExecutor.js");
      assert.ok(workflowExec);
      assert.ok(!workflowExec.text.includes("workflowRunner.js"));

      // Pair 2: promptBuilderProService -> ElementService (must not exist)
      const promptBuilder = files.find((f) => f.rel === "src/systems/elements/internal/services/promptBuilderProService.js");
      assert.ok(promptBuilder);
      assert.ok(!promptBuilder.text.includes("elementService.js"));
      assert.ok(!promptBuilder.text.includes("ElementService.js"));

      // Pair 3: catalogPresentation -> models/index.js (must not exist)
      const catalogPres = files.find((f) => f.rel === "src/systems/models/internal/services/catalogPresentation.js");
      assert.ok(catalogPres);
      assert.ok(!catalogPres.text.includes("./index.js"));
    });
  });

  describe("Rule R18: Standalone workflow-engine closed allowlist", () => {
    it("allows #shared, node:*, and intra-system relative imports in internal/core/**", () => {
      const file = makeFile(
        "src/systems/workflow-engine/internal/core/ExecutionEngine.js",
        `import { randomUUID } from "node:crypto";\nimport { createLogger } from "#shared";\nimport { GraphCompiler } from "./GraphCompiler.js";\n`
      );
      assert.equal(checkRuleR18(file).length, 0);
    });

    it("forbids #models/tools, #shared/redis, bullmq, ioredis, and peer systems in internal/core/**", () => {
      const file = makeFile(
        "src/systems/workflow-engine/internal/core/ExecutionEngine.js",
        [
          `import { executeLLM } from "#models/tools";`,
          `import { redisConnection } from "#shared/redis";`,
          `import { Queue } from "bullmq";`,
          `import Redis from "ioredis";`,
          `import { markMediaFailed } from "#media/tools";`,
        ].join("\n")
      );
      assert.equal(checkRuleR18(file).length, 5);
    });

    it("allows #shared and #models/tools in Base Nodes, but forbids peer systems and third-party SDKs", () => {
      const okNode = makeFile(
        "src/systems/workflow-engine/internal/nodes/base/llmNode.js",
        `import { executeLLM } from "#models/tools";\nimport { createLogger } from "#shared";\nimport { WorkflowSafetyError } from "../../errors.js";\n`
      );
      assert.equal(checkRuleR18(okNode).length, 0);

      const badNode = makeFile(
        "src/systems/workflow-engine/internal/nodes/base/resolveRefsNode.js",
        [
          `import { getCharacterPromptContext } from "#characters/tools";`,
          `import { Redis } from "@upstash/redis";`,
          `import OpenAI from "openai";`,
        ].join("\n")
      );
      assert.equal(checkRuleR18(badNode).length, 3);
    });

    it('allows "yaml" only inside internal/skills/** and blocks it elsewhere', () => {
      const okSkill = makeFile(
        "src/systems/workflow-engine/internal/skills/index.js",
        `import { readFileSync } from "node:fs";\nimport { parse } from "yaml";\nimport { WorkflowValidationError } from "../errors.js";\n`
      );
      assert.equal(checkRuleR18(okSkill).length, 0);

      const badYamlInCore = makeFile(
        "src/systems/workflow-engine/internal/core/GraphCompiler.js",
        `import { parse } from "yaml";\n`
      );
      assert.equal(checkRuleR18(badYamlInCore).length, 1);
    });
  });
});
}
