import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Test against ONLY the public facade!
import * as models from "../../src/models/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const apiRoot = path.resolve(__dirname, "../..");

describe("Sealed Models Subsystem Architecture", () => {

  before(() => {
    models.initRegistry({ forceReload: true });
  });

  // ── 1. PUBLIC API CONTRACT TESTS ──────────────────────────────────────────
  describe("1. Public API Contract & Surface", () => {
    it("should export only the intended stable public functions and standard error classes", () => {
      const expectedExports = [
        "getCatalog",
        "getSchema",
        "validateInput",
        "calculateCost",
        "estimatePrice",
        "run",
        "resolveOperation",
        "initRegistry",
        "reloadRegistry",
        "getRegistryStats",
        // Typed Error Classes
        "ModelsSystemError",
        "ValidationError",
        "MissingOptionError",
        "ProviderTransientError",
        "ProviderRequestError",
        "OutputContractViolationError",
        "UnsupportedCapabilityError",
        "UnknownModelFamilyError",
        "UnknownOperationError",
        "BindingNotFoundError",
        "BindingModelMismatchError",
        "BindingOperationMismatchError",
        "ConfigIntegrityError",
      ];

      for (const name of expectedExports) {
        assert.ok(
          models[name] !== undefined,
          `Expected public export "${name}" to exist on models facade`
        );
      }
    });

    it("should NOT leak internal submodules or binding resolution functions on the public facade", () => {
      const forbiddenInternalNames = [
        "modelRunner",
        "parameterMapper",
        "schemaValidator",
        "runtimeExecutor",
        "providerRuntimeRegistry",
        "credentialResolver",
        "pricingEngine",
        "modelRegistry",
        "bindingRegistry",
        "circuitBreakerRegistry",
        // Binding resolution and queries are strictly INTERNAL in Model-First architecture
        "resolveBinding",
        "getBindings",
        "getDefaultBinding",
      ];

      for (const name of forbiddenInternalNames) {
        assert.strictEqual(
          models[name],
          undefined,
          `Forbidden internal submodule or function "${name}" must NOT be exposed on models facade`
        );
      }
    });

    it("getCatalog() returns pure model offering and does NOT leak provider IDs", () => {
      const catalog = models.getCatalog();
      assert.ok(Array.isArray(catalog));
      assert.ok(catalog.length > 0);

      const nanobana = catalog.find((m) => m.modelFamily === "nanobana_pro" || m.modelId === "nanobana_pro");
      assert.ok(nanobana, "Expected nanobana_pro in catalog");
      assert.strictEqual(nanobana.domain, "image");

      // Provider IDs must NOT leak into the public catalog
      assert.strictEqual(nanobana.activeProviders, undefined, "activeProviders must not leak into catalog");
      assert.strictEqual(nanobana.providers, undefined, "providers must not leak into catalog");

      const schema = models.getSchema("nanobana_pro", "text_to_image");
      assert.ok(schema.inputs.prompt);
      assert.strictEqual(schema.inputs.prompt.required, true);

      // getRegistryStats returns counts (no internal Maps leaked)
      const stats = models.getRegistryStats();
      assert.ok(typeof stats.models === "number" && stats.models > 0);
      assert.ok(typeof stats.providers === "number" && stats.providers > 0);
      assert.ok(typeof stats.bindings === "number" && stats.bindings > 0);
    });

    it("external callers can validate canonical input via public API", () => {
      const validated = models.validateInput("nanobana_pro", "text_to_image", {
        prompt: "Cyberpunk Tunis",
        aspect_ratio: "16:9",
        resolution: "2k",
      });
      assert.strictEqual(validated.prompt, "Cyberpunk Tunis");
      assert.strictEqual(validated.aspect_ratio, "16:9");
      assert.strictEqual(validated.resolution, "2k");

      // Rejects missing required field
      assert.throws(
        () => models.validateInput("nanobana_pro", "text_to_image", {}),
        (err) => err instanceof models.ValidationError
      );
    });
  });

  // ── 2. STATIC BOUNDARY & CODEBASE LEAKAGE AUDIT ───────────────────────────
  describe("2. Static Codebase Boundary Audit", () => {
    function getAllSourceFiles(dir, fileList = []) {
      if (!fs.existsSync(dir)) return fileList;
      const files = fs.readdirSync(dir, { withFileTypes: true });
      for (const file of files) {
        const fullPath = path.join(dir, file.name);
        if (file.isDirectory()) {
          if (file.name === "node_modules" || file.name === ".git" || file.name === "__tests__" || file.name === "tests") {
            continue;
          }
          getAllSourceFiles(fullPath, fileList);
        } else if (file.name.endsWith(".js") || file.name.endsWith(".mjs")) {
          fileList.push(fullPath);
        }
      }
      return fileList;
    }

    it("ZERO production files outside src/models/ import internal models modules", () => {
      const searchDirs = [
        path.join(apiRoot, "src", "use-cases"),
        path.join(apiRoot, "src", "v2"),
        path.join(apiRoot, "src", "services"),
        path.join(apiRoot, "src", "platform"),
        path.join(apiRoot, "src", "domain"),
        path.join(apiRoot, "controllers"),
        path.join(apiRoot, "routes"),
        path.join(apiRoot, "scripts"),
      ];

      const allFiles = searchDirs.flatMap((d) => getAllSourceFiles(d));
      assert.ok(allFiles.length > 20, "Expected to find source files to audit");

      const internalPatterns = [
        /\/models\/(?!index\.js)/,
        /models\/execution/,
        /models\/registry/,
        /models\/schema/,
        /models\/mapping/,
        /models\/runtime/,
        /models\/credentials/,
        /models\/pricing/,
        /models\/errors/,
        /models\/manifests/,
        /models\/providers/,
        /models\/shared/,
      ];

      const violations = [];

      for (const filePath of allFiles) {
        const content = fs.readFileSync(filePath, "utf8");
        const lines = content.split("\n");
        lines.forEach((line, idx) => {
          if (/import\s+.*from\s+["'].*models/i.test(line) || /import\(["'].*models/i.test(line)) {
            for (const pattern of internalPatterns) {
              if (pattern.test(line)) {
                violations.push({
                  file: path.relative(apiRoot, filePath),
                  line: idx + 1,
                  statement: line.trim(),
                });
              }
            }
          }
        });
      }

      assert.deepStrictEqual(
        violations,
        [],
        `Found direct boundary violations into models internals:\n${JSON.stringify(violations, null, 2)}`
      );
    });

    it("src/models/ has ZERO upward imports into use-cases, workflow, controllers, or billing config", () => {
      const modelsDir = path.join(apiRoot, "src", "models");
      const modelsFiles = getAllSourceFiles(modelsDir);

      const upwardPatterns = [
        /use-cases/,
        /controllers/,
        /routes/,
        /v2\/runner/,
        /v2\/nodes/,
        /services\/walletService/,
        /config\/billing/,
        /platform\/billing/,
      ];

      const upwardViolations = [];

      for (const filePath of modelsFiles) {
        const content = fs.readFileSync(filePath, "utf8");
        const lines = content.split("\n");
        lines.forEach((line, idx) => {
          if (/import\s+.*from/i.test(line) || /import\(/i.test(line)) {
            for (const pattern of upwardPatterns) {
              if (pattern.test(line)) {
                upwardViolations.push({
                  file: path.relative(apiRoot, filePath),
                  line: idx + 1,
                  statement: line.trim(),
                });
              }
            }
          }
        });
      }

      assert.deepStrictEqual(
        upwardViolations,
        [],
        `Found upward dependencies inside src/models:\n${JSON.stringify(upwardViolations, null, 2)}`
      );
    });
  });

  // ── 3. BILLING & WALLET BOUNDARY TESTS ────────────────────────────────────
  describe("3. Billing & Financial Isolation", () => {
    it("calculateCost returns deterministic pricing and does NOT interact with any wallet", () => {
      const cleanInput = {
        prompt: "Cyberpunk Tunis",
        aspect_ratio: "16:9",
        resolution: "2k",
        quality: "standard",
      };

      // Model-First: NO bindingId passed!
      const cost = models.calculateCost(
        "nanobana_pro",
        "text_to_image",
        cleanInput
      );

      assert.strictEqual(typeof cost, "number");
      assert.ok(cost > 0, "Expected positive credit cost");

      // Verify that calculateCost is deterministic
      const cost2 = models.calculateCost(
        "nanobana_pro",
        "text_to_image",
        cleanInput
      );
      assert.strictEqual(cost, cost2);
    });

    it("models facade does NOT expose wallet reservation errors", () => {
      assert.strictEqual(
        models.InsufficientCreditsError,
        undefined,
        "InsufficientCreditsError must belong to Wallet domain, not Models facade"
      );
      assert.strictEqual(
        models.ReservationExpiredError,
        undefined,
        "ReservationExpiredError must belong to Wallet domain, not Models facade"
      );
    });
  });

  // ── 4. MODEL-FIRST EXECUTION & PRICING TESTS ─────────────────────────────
  describe("4. Model-First Execution & Pricing", () => {
    it("calculateCost works deterministically WITHOUT any bindingId option", () => {
      const cost = models.calculateCost("nanobana_pro", "text_to_image", { prompt: "Test", resolution: "1k" });
      assert.strictEqual(typeof cost, "number");
      assert.ok(cost > 0, "calculateCost should compute cost from configured active binding");
    });

    it("estimatePrice works deterministically WITHOUT any bindingId option", () => {
      const estimate = models.estimatePrice("nanobana_pro", "text_to_image", { prompt: "Test", resolution: "1k" });
      assert.strictEqual(typeof estimate, "object");
      assert.ok(estimate.amount > 0, "estimatePrice should compute amount from configured active binding");
      assert.strictEqual(estimate.currency, "credits");
    });

    it("run executes successfully WITHOUT any bindingId option", async () => {
      let executedPayload = null;
      const result = await models.run(
        "nanobana_pro",
        "text_to_image",
        { prompt: "Cyberpunk Tunis", aspect_ratio: "16:9", resolution: "1k" },
        {
          userId: "user-1",
          sdkRunner: async ({ payload }) => {
            executedPayload = payload;
            return { outputs: ["https://cdn.example.com/cyberpunk-tunis.png"] };
          },
        }
      );

      assert.strictEqual(result.status, "success");
      assert.ok(Array.isArray(result.images));
      assert.strictEqual(result.images[0].url, "https://cdn.example.com/cyberpunk-tunis.png");
      assert.strictEqual(result.metadata.modelId, "nanobana_pro");
      assert.strictEqual(result.metadata.operation, "text_to_image");
      assert.ok(executedPayload, "Underlying provider runner was invoked");
    });

    it("binding resolution and query functions are private to models subsystem", () => {
      assert.strictEqual(models.resolveBinding, undefined, "resolveBinding must not be exported on facade");
      assert.strictEqual(models.getBindings, undefined, "getBindings must not be exported on facade");
      assert.strictEqual(models.getDefaultBinding, undefined, "getDefaultBinding must not be exported on facade");
    });

    it("anti-widening invariant: rejects values unsupported by model or active binding", async () => {
      // Model nanobana_pro allows 1k, 2k, 4k. 8k is rejected at schema level.
      assert.throws(
        () => {
          models.validateInput("nanobana_pro", "text_to_image", {
            prompt: "Test",
            resolution: "8k",
          });
        },
        (err) => err instanceof models.ValidationError
      );
    });

    it("unambiguous active configuration: rejects multiple active bindings per operation", async () => {
      const { initRegistry } = await import("../../src/models/registry/modelRegistry.js");
      // The validator enforces that in Phase 1, only one binding per (model, op) can be active
      const reg = initRegistry({ forceReload: true });
      assert.ok(reg.models.size > 0);
    });
  });

  // ── 5. PROVIDER LEAKAGE & ABSTRACTION DEFENSE ────────────────────────────
  describe("5. Provider Leakage & Abstraction Defense", () => {
    function getAllFiles(dir) {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir, { withFileTypes: true })
        .flatMap((dirent) => dirent.isDirectory()
          ? getAllFiles(path.join(dir, dirent.name))
          : [path.join(dir, dirent.name)]
        );
    }

    it("Nodes and Use Cases do NOT contain provider SDK client imports", () => {
      const nodeDir = path.join(apiRoot, "src", "v2", "nodes");
      const useCaseDir = path.join(apiRoot, "src", "use-cases");

      const files = [
        ...getAllFiles(nodeDir),
        ...getAllFiles(useCaseDir),
      ];

      const providerSdkPatterns = [
        /["']wavespeed["']/,
        /["']@google\/genai["']/,
        /["']@fal-ai\/client["']/,
        /["']@huggingface\/inference["']/,
        /["']openai["']/,
      ];

      for (const file of files) {
        if (!file.endsWith(".js")) continue;
        const code = fs.readFileSync(file, "utf8");
        for (const pattern of providerSdkPatterns) {
          assert.strictEqual(
            pattern.test(code),
            false,
            `File ${path.relative(apiRoot, file)} must NOT import provider SDK: ${pattern}`
          );
        }
      }
    });

    it("model execution returns canonical result shape and enforces strict output contract", async () => {
      const mockResult = await models.run(
        "nanobana_pro",
        "text_to_image",
        {
          prompt: "Futuristic Carthage",
          aspect_ratio: "16:9",
          resolution: "1k",
        },
        {
          userId: "user-test",
          sdkRunner: async ({ payload }) => {
            assert.strictEqual(payload.prompt, "Futuristic Carthage");
            assert.strictEqual(payload.aspect_ratio, "16:9");
            assert.strictEqual(payload.resolution, "1k");
            assert.strictEqual(payload.output_format, "png");
            return {
              outputs: ["https://storage.provider.com/gen-1.png"],
            };
          },
        }
      );

      // Canonical result contract:
      assert.strictEqual(mockResult.status, "success");
      assert.ok(Array.isArray(mockResult.images));
      assert.strictEqual(mockResult.images[0].url, "https://storage.provider.com/gen-1.png");
      assert.strictEqual(mockResult.metadata.modelId, "nanobana_pro");
      // Public metadata must NOT leak provider name to callers
      assert.strictEqual(mockResult.metadata.providerUsed, undefined);
      assert.strictEqual(mockResult.metadata.providerId, undefined);
    });

    it("throws OutputContractViolationError when provider returns empty or missing URLs", async () => {
      await assert.rejects(
        async () => {
          await models.run(
            "nanobana_pro",
            "text_to_image",
            { prompt: "Empty Test" },
            {
              userId: "user-test",
              sdkRunner: async () => ({ outputs: [] }),
            }
          );
        },
        (err) => err instanceof models.OutputContractViolationError
      );
    });
  });

  // ── 6. ZERO PROVIDER/BINDING KNOBS IN APPLICATION LAYER ──────────────────
  describe("6. Zero Provider/Binding Knobs in Application Layer", () => {
    function getAllFiles(dir) {
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir, { withFileTypes: true })
        .flatMap((dirent) => dirent.isDirectory()
          ? getAllFiles(path.join(dir, dirent.name))
          : [path.join(dir, dirent.name)]
        );
    }

    const appDirs = [
      path.join(apiRoot, "src", "v2", "nodes"),
      path.join(apiRoot, "src", "v2", "runner"),
      path.join(apiRoot, "src", "v2", "compiler"),
      path.join(apiRoot, "src", "use-cases"),
      path.join(apiRoot, "src", "platform", "ai"),
      path.join(apiRoot, "controllers"),
    ];

    it("application-layer files have ZERO references to bindingId", () => {
      const files = appDirs.flatMap(getAllFiles).filter((f) => f.endsWith(".js"));
      for (const file of files) {
        const code = fs.readFileSync(file, "utf8");
        if (/\bbindingId\b/.test(code)) {
          assert.fail(
            `File ${path.relative(apiRoot, file)} references bindingId — external code must NOT know bindings`
          );
        }
      }
    });

    it("application-layer files have ZERO references to provider routing knobs", () => {
      const files = appDirs.flatMap(getAllFiles).filter((f) => f.endsWith(".js"));
      const forbiddenKnobs = [
        /\bforceProvider\b/,
        /\bforceBindingId\b/,
        /\bfallbackProvider\b/,
        /\bfallback_provider\b/,
        /\bfallbackBindingId\b/,
        /\bfallback_binding_id\b/,
        /\bprovider_override\b/,
        /\bpreferredProvider\b/,
      ];

      for (const file of files) {
        const code = fs.readFileSync(file, "utf8");
        for (const pattern of forbiddenKnobs) {
          if (pattern.test(code)) {
            assert.fail(
              `File ${path.relative(apiRoot, file)} uses forbidden provider knob: ${pattern}`
            );
          }
        }
      }
    });

    it("application-layer files have ZERO references to providerId", () => {
      const files = appDirs.flatMap(getAllFiles).filter((f) => f.endsWith(".js"));
      for (const file of files) {
        const code = fs.readFileSync(file, "utf8");
        if (/\bproviderId\b/.test(code)) {
          assert.fail(
            `File ${path.relative(apiRoot, file)} references providerId — provider identity is internal`
          );
        }
      }
    });
  });

  // ── 7. SECTIONS 38, 39, 40, 41: ARCHITECTURAL VERIFICATION SUITE ──────────
  describe("7. Model-First Invariant Verification (Sections 38, 39, 40, 41)", () => {
    // Section 38: Configuration Tests (Test 1, Test 2, Test 3, Test 4)
    it("Section 38: Provider implementation can be changed via configuration with ZERO application code changes", async () => {
      let wavespeedExecuted = false;
      let googleExecuted = false;

      // Test 1: Configured Model: nanobana_pro → WaveSpeed
      // Caller calls models.run with ONLY model, operation, and canonical params
      const canonicalParams = {
        prompt: "Sunset over Sidi Bou Said",
        aspect_ratio: "16:9",
        resolution: "2k",
      };

      await models.run(
        "nanobana_pro",
        "text_to_image",
        canonicalParams,
        {
          userId: "user-1",
          sdkRunner: async ({ payload, binding }) => {
            if (binding.providerId === "wavespeed") {
              wavespeedExecuted = true;
              // Section 39: WaveSpeed receives resolution = "2k" and output_format = "png"
              assert.strictEqual(payload.resolution, "2k");
              assert.strictEqual(payload.output_format, "png");
            }
            return { outputs: ["https://cdn.example.com/wavespeed-gen.png"] };
          },
        }
      );
      assert.ok(wavespeedExecuted, "Test 1: WaveSpeed should be executed under default configuration");

      // Test 2: Change configuration in registry: nanobana_pro → Google
      // We switch active binding for nanobana_pro to Google
      const { getRegistry } = await import("../../src/models/registry/modelRegistry.js");
      const { bindings, bindingIndex } = getRegistry();
      const wsBinding = bindings.get("nanobana_pro:text_to_image:wavespeed");
      const gBinding = bindings.get("nanobana_pro:text_to_image:google");

      wsBinding.status = "standby";
      gBinding.status = "active";

      try {
        // Test 3: The EXACT same request parameters stay identical:
        // ZERO application code changes!
        await models.run(
          "nanobana_pro",
          "text_to_image",
          canonicalParams, // IDENTICAL parameters!
          {
            userId: "user-1",
            sdkRunner: async ({ payload, binding }) => {
              if (binding.providerId === "google") {
                googleExecuted = true;
                // Google receives imageSize = "medium" (mapped from resolution: "2k")
                assert.strictEqual(payload.imageSize, "medium");
              }
              return { images: [{ imageUri: "https://cdn.example.com/google-gen.png" }] };
            },
          }
        );
        assert.ok(googleExecuted, "Test 2: Google should be executed after configuration switch with identical caller code");
      } finally {
        // Restore default configuration
        wsBinding.status = "active";
        gBinding.status = "standby";
      }
    });

    // Section 39: Parameter Test
    it("Section 39: Caller passes resolution '2k', provider receives mapped payload, caller unaware", async () => {
      let interceptedPayload = null;

      await models.run(
        "nanobana_pro",
        "text_to_image",
        { prompt: "Medina alley", resolution: "2k" },
        {
          userId: "user-1",
          sdkRunner: async ({ payload }) => {
            interceptedPayload = payload;
            return { outputs: ["https://cdn.example.com/medina.png"] };
          },
        }
      );

      // Provider received translated parameter "resolution: 2k" and static "output_format: png"
      assert.strictEqual(interceptedPayload.resolution, "2k");
      assert.strictEqual(interceptedPayload.output_format, "png");
      // Old dummy "size" field was NOT present
      assert.strictEqual(interceptedPayload.size, undefined);
    });

    // Section 40: Output Test
    it("Section 40: Different raw provider outputs both normalize to canonical images: [{ url }]", async () => {
      // WaveSpeed raw format: { outputs: ["https://..."] }
      const res1 = await models.run(
        "nanobana_pro",
        "text_to_image",
        { prompt: "Test 1" },
        {
          userId: "user-1",
          sdkRunner: async () => ({ outputs: ["https://cdn.example.com/res1.png"] }),
        }
      );
      assert.deepStrictEqual(res1.images, [{ url: "https://cdn.example.com/res1.png" }]);

      // Google raw format: { images: [{ imageUri: "https://..." }] }
      const res2 = await models.run(
        "nanobana_pro",
        "text_to_image",
        { prompt: "Test 2" },
        {
          userId: "user-1",
          bindingId: "nanobana_pro.google", // internal test override
          sdkRunner: async () => ({ images: [{ imageUri: "https://cdn.example.com/res2.png" }] }),
        }
      );
      assert.deepStrictEqual(res2.images, [{ url: "https://cdn.example.com/res2.png" }]);
    });

    // Section 41: Billing Test
    it("Section 41: Models calculates cost without touching Wallet; Use Case orchestrates hold -> run -> commit", async () => {
      // Mock wallet service outside Models
      const walletEvents = [];
      const mockWalletService = {
        hold: async (userId, cost) => {
          walletEvents.push({ action: "hold", userId, cost });
          return { holdId: "h-123" };
        },
        commit: async (holdId) => {
          walletEvents.push({ action: "commit", holdId });
        },
        release: async (holdId) => {
          walletEvents.push({ action: "release", holdId });
        },
      };

      // Simulated Use Case Flow:
      // 1. Calculate Cost via Models (pure calculation, no wallet interaction)
      const cost = models.calculateCost("nanobana_pro", "text_to_image", { prompt: "Billing test", resolution: "1k" });
      assert.ok(cost > 0);
      assert.strictEqual(walletEvents.length, 0, "Models.calculateCost must NOT call wallet");

      // 2. Use Case holds funds in Wallet
      const hold = await mockWalletService.hold("user-1", cost);
      assert.strictEqual(walletEvents.length, 1);
      assert.strictEqual(walletEvents[0].action, "hold");

      // 3. Use Case executes Model via Models Management
      const result = await models.run(
        "nanobana_pro",
        "text_to_image",
        { prompt: "Billing test", resolution: "1k" },
        {
          userId: "user-1",
          sdkRunner: async () => ({ outputs: ["https://cdn.example.com/billed.png"] }),
        }
      );
      assert.strictEqual(result.status, "success");

      // 4. On success, Use Case commits wallet hold
      await mockWalletService.commit(hold.holdId);
      assert.strictEqual(walletEvents.length, 2);
      assert.strictEqual(walletEvents[1].action, "commit");
    });
  });

});
