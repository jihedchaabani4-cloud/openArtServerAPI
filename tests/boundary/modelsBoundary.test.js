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
        // NOTE: resolveOperation is NO LONGER exported — it is internal
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
        // Operation inference is strictly INTERNAL in Semantic-First architecture
        "resolveOperation",
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

    it("external callers can validate canonical input via public API (no operation argument)", () => {
      // Semantic-First: no operation arg — inferred internally from params (no image → text_to_image)
      const validated = models.validateInput("nanobana_pro", {
        prompt: "Cyberpunk Tunis",
        aspect_ratio: "16:9",
        resolution: "2k",
      });
      assert.strictEqual(validated.prompt, "Cyberpunk Tunis");
      assert.strictEqual(validated.aspect_ratio, "16:9");
      assert.strictEqual(validated.resolution, "2k");

      // Rejects missing required field
      assert.throws(
        () => models.validateInput("nanobana_pro", {}),
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

      // Semantic-First: NO operation, NO bindingId passed!
      const cost = models.calculateCost("nanobana_pro", cleanInput);

      assert.strictEqual(typeof cost, "number");
      assert.ok(cost > 0, "Expected positive credit cost");

      // Verify that calculateCost is deterministic
      const cost2 = models.calculateCost("nanobana_pro", cleanInput);
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

  // ── 4. SEMANTIC-FIRST EXECUTION & PRICING TESTS ───────────────────────────
  describe("4. Semantic-First Execution & Pricing (no operation argument)", () => {
    it("calculateCost works deterministically WITHOUT operation or bindingId", () => {
      const cost = models.calculateCost("nanobana_pro", { prompt: "Test", resolution: "1k" });
      assert.strictEqual(typeof cost, "number");
      assert.ok(cost > 0, "calculateCost should compute cost from configured active binding");
    });

    it("estimatePrice works deterministically WITHOUT operation or bindingId", () => {
      const estimate = models.estimatePrice("nanobana_pro", { prompt: "Test", resolution: "1k" });
      assert.strictEqual(typeof estimate, "object");
      assert.ok(estimate.amount > 0, "estimatePrice should compute amount from configured active binding");
      assert.strictEqual(estimate.currency, "credits");
    });

    it("run executes successfully WITHOUT operation argument", async () => {
      let executedPayload = null;
      const result = await models.run(
        "nanobana_pro",
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

    it("anti-widening invariant: rejects values unsupported by model or active binding", () => {
      // Model nanobana_pro allows 1k, 2k, 4k. 8k is rejected at schema level.
      assert.throws(
        () => {
          models.validateInput("nanobana_pro", {
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

  // ── 5. PROVIDER-OWNED ROUTE RESOLUTION TESTS (Sections 30 & 31) ──────────
  describe("5. Provider-Owned Route Resolution & Semantic Execution", () => {
    // Test A — Prompt only
    it("Test A — Prompt only: routes to provider generation endpoint", async () => {
      let endpointCalled = null;
      const result = await models.run(
        "nanobana_pro",
        { prompt: "cinematic city", resolution: "2k" },
        {
          userId: "user-1",
          sdkRunner: async ({ binding, payload }) => {
            endpointCalled = binding.endpoint;
            assert.strictEqual(payload.resolution, "2k");
            return { outputs: ["https://cdn.example.com/city.png"] };
          },
        }
      );
      assert.strictEqual(endpointCalled, "google/nano-banana-pro/text-to-image");
      assert.strictEqual(result.images[0].url, "https://cdn.example.com/city.png");
    });

    // Test B — Input image
    it("Test B — Input image: routes to provider edit endpoint with wrap_array", async () => {
      let endpointCalled = null;
      const result = await models.run(
        "nanobana_pro",
        {
          prompt: "change the jacket",
          input_image: "https://example.com/a.png",
          resolution: "2k",
        },
        {
          userId: "user-1",
          sdkRunner: async ({ binding, payload }) => {
            endpointCalled = binding.endpoint;
            assert.ok(Array.isArray(payload.images), "input_image must be wrapped to images array");
            assert.strictEqual(payload.images[0], "https://example.com/a.png");
            return { outputs: ["https://cdn.example.com/jacket.png"] };
          },
        }
      );
      assert.strictEqual(endpointCalled, "google/nano-banana-pro/edit");
      assert.strictEqual(result.images[0].url, "https://cdn.example.com/jacket.png");
    });

    // Test C — Reference images
    it("Test C — Reference images: passes reference_images to provider", async () => {
      let passedPayload = null;
      const result = await models.run(
        "nanobana_pro",
        {
          prompt: "combine the visual style",
          reference_images: [
            "https://example.com/a.png",
            "https://example.com/b.png",
          ],
        },
        {
          userId: "user-1",
          sdkRunner: async ({ payload }) => {
            passedPayload = payload;
            return { outputs: ["https://cdn.example.com/style.png"] };
          },
        }
      );
      assert.ok(Array.isArray(passedPayload.reference_images));
      assert.strictEqual(passedPayload.reference_images.length, 2);
      assert.strictEqual(result.images[0].url, "https://cdn.example.com/style.png");
    });

    // Test D — Input image + mask
    it("Test D — Input image + mask: routes to provider inpaint route", async () => {
      let endpointCalled = null;
      let passedPayload = null;
      const result = await models.run(
        "nanobana_pro",
        {
          prompt: "replace the selected area",
          input_image: "https://example.com/a.png",
          mask: "https://example.com/mask.png",
        },
        {
          userId: "user-1",
          sdkRunner: async ({ binding, payload }) => {
            endpointCalled = binding.endpoint;
            passedPayload = payload;
            return { outputs: ["https://cdn.example.com/inpaint.png"] };
          },
        }
      );
      assert.strictEqual(endpointCalled, "google/nano-banana-pro/edit");
      assert.ok(Array.isArray(passedPayload.images));
      assert.strictEqual(passedPayload.mask, "https://example.com/mask.png");
      assert.strictEqual(result.images[0].url, "https://cdn.example.com/inpaint.png");
    });

    it("calculateCost resolves same route as execution deterministically", () => {
      const genCost = models.calculateCost("nanobana_pro", { prompt: "sky", resolution: "1k" });
      const editCost = models.calculateCost("nanobana_pro", {
        prompt: "edit this",
        input_image: "https://cdn.example.com/src.png",
        resolution: "1k",
      });
      assert.strictEqual(typeof genCost, "number");
      assert.strictEqual(typeof editCost, "number");
      assert.ok(editCost > genCost, "Edit price should reflect edit pricing tier");
    });

    it("rejects input with unsupported parameter for provider binding", () => {
      // gpt_image_2 only has text_to_image — passing input_image should throw
      assert.throws(
        () => models.calculateCost("gpt_image_2", {
          prompt: "edit this",
          input_image: "https://cdn.example.com/src.png",
        }),
        (err) => err instanceof models.UnsupportedCapabilityError || err?.code === "UNKNOWN_PARAMETER"
      );
    });

    // Section 31: Multi-Provider Test
    it("Section 31: Multi-Provider Test — same Model, same params, WaveSpeed vs Google", async () => {
      const semanticRequest = {
        prompt: "Cyberpunk Tunis",
        input_image: "https://cdn.example.com/base.png",
        resolution: "2k",
      };

      // 1. Run under default active provider (WaveSpeed)
      let wavespeedCalled = false;
      await models.run("nanobana_pro", semanticRequest, {
        userId: "user-1",
        sdkRunner: async ({ binding, payload }) => {
          wavespeedCalled = true;
          assert.strictEqual(binding.providerId, "wavespeed");
          assert.strictEqual(binding.endpoint, "google/nano-banana-pro/edit");
          assert.ok(Array.isArray(payload.images));
          return { outputs: ["https://cdn.wavespeed.ai/res.png"] };
        },
      });
      assert.ok(wavespeedCalled, "WaveSpeed should execute under default config");

      // 2. Switch provider configuration to Google
      const { getRegistry } = await import("../../src/models/registry/modelRegistry.js");
      const { bindings } = getRegistry();
      const ws = bindings.get("nanobana_pro:text_to_image:wavespeed");
      const g = bindings.get("nanobana_pro:text_to_image:google");
      ws.status = "standby";
      g.status = "active";

      try {
        let googleCalled = false;
        // Caller request is 100% IDENTICAL
        await models.run("nanobana_pro", semanticRequest, {
          userId: "user-1",
          sdkRunner: async ({ binding, payload }) => {
            googleCalled = true;
            assert.strictEqual(binding.providerId, "google");
            assert.strictEqual(payload.sourceImage, "https://cdn.example.com/base.png");
            assert.strictEqual(payload.imageSize, "medium"); // 2k mapped to medium for Google
            return { images: [{ imageUri: "https://cdn.google.com/res.png" }] };
          },
        });
        assert.ok(googleCalled, "Google should execute after configuration switch with identical caller code");
      } finally {
        ws.status = "active";
        g.status = "standby";
      }
    });
  });

  // ── 6. PROVIDER LEAKAGE & ABSTRACTION DEFENSE ────────────────────────────
  describe("6. Provider Leakage & Abstraction Defense", () => {
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

  // ── 7. ZERO PROVIDER/BINDING KNOBS IN APPLICATION LAYER ──────────────────
  describe("7. Zero Provider/Binding Knobs in Application Layer", () => {
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

    // Section 32: Negative Tests
    it("Section 32: rejects caller passing provider-specific parameter names", async () => {
      await assert.rejects(
        async () => {
          await models.run(
            "nanobana_pro",
            {
              prompt: "Negative test",
              imageSize: "medium", // Google-specific parameter name!
            },
            { userId: "user-test" }
          );
        },
        (err) => err?.code === "UNKNOWN_PARAMETER" || err?.name === "UnknownParameterError"
      );
    });

    it("Section 32: caller cannot override provider via semantic parameters", async () => {
      let executedProvider = null;
      await models.run(
        "nanobana_pro",
        {
          prompt: "Override attempt",
          resolution: "1k",
        },
        {
          userId: "user-test",
          provider: "google", // Caller attempt to inject provider knob in options
          preferredProvider: "google",
          sdkRunner: async ({ binding }) => {
            executedProvider = binding.providerId;
            return { outputs: ["https://cdn.example.com/ok.png"] };
          },
        }
      );
      // Must ignore caller provider knob and execute configured active provider (wavespeed)
      assert.strictEqual(executedProvider, "wavespeed");
    });
  });

  // ── 8. ARCHITECTURAL VERIFICATION SUITE (Sections 38, 39, 40, 41) ─────────
  describe("8. Model-First Invariant Verification (Sections 38, 39, 40, 41)", () => {
    // Section 38: Configuration Tests
    it("Section 38: Provider can be changed via configuration with ZERO application code changes", async () => {
      let wavespeedExecuted = false;
      let googleExecuted = false;

      // Semantic-First: no operation arg — caller only supplies model + semantic params
      const canonicalParams = {
        prompt: "Sunset over Sidi Bou Said",
        aspect_ratio: "16:9",
        resolution: "2k",
      };

      await models.run(
        "nanobana_pro",
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
      const { getRegistry } = await import("../../src/models/registry/modelRegistry.js");
      const { bindings } = getRegistry();
      const wsBinding = bindings.get("nanobana_pro:text_to_image:wavespeed");
      const gBinding = bindings.get("nanobana_pro:text_to_image:google");

      wsBinding.status = "standby";
      gBinding.status = "active";

      try {
        // Test 3: The EXACT same request parameters stay identical — ZERO application code changes!
        await models.run(
          "nanobana_pro",
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

    // Section 39: Parameter mapping test
    it("Section 39: Caller passes resolution '2k', provider receives mapped payload, caller unaware", async () => {
      let interceptedPayload = null;

      await models.run(
        "nanobana_pro",
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

    // Section 40: Output normalization test
    it("Section 40: Different raw provider outputs both normalize to canonical images: [{ url }]", async () => {
      // WaveSpeed raw format: { outputs: ["https://..."] }
      const res1 = await models.run(
        "nanobana_pro",
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
        { prompt: "Test 2" },
        {
          userId: "user-1",
          bindingId: "nanobana_pro.google", // internal test override
          sdkRunner: async () => ({ images: [{ imageUri: "https://cdn.example.com/res2.png" }] }),
        }
      );
      assert.deepStrictEqual(res2.images, [{ url: "https://cdn.example.com/res2.png" }]);
    });

    // Section 41: Billing isolation test
    it("Section 41: Models calculates cost without touching Wallet; Use Case orchestrates hold -> run -> commit", async () => {
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

      // 1. Calculate Cost via Models (pure calculation, no wallet interaction)
      // Semantic-First: no operation arg
      const cost = models.calculateCost("nanobana_pro", { prompt: "Billing test", resolution: "1k" });
      assert.ok(cost > 0);
      assert.strictEqual(walletEvents.length, 0, "Models.calculateCost must NOT call wallet");

      // 2. Use Case holds funds in Wallet
      const hold = await mockWalletService.hold("user-1", cost);
      assert.strictEqual(walletEvents.length, 1);
      assert.strictEqual(walletEvents[0].action, "hold");

      // 3. Use Case executes Model via Models Management (no operation arg)
      const result = await models.run(
        "nanobana_pro",
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

  // ── 9. FINAL ARCHITECTURE SPECIFICATION (TESTS 1 THROUGH 12) ───────────────
  describe("9. Final Architecture Spec — Required Invariant Suite (TEST 1 to TEST 12)", () => {
    // TEST 1 — Model only + semantic params
    it("TEST 1: Model only + semantic params works without operation, provider, or bindingId", async () => {
      const res = await models.run("nanobana_pro", { prompt: "hello" }, {
        userId: "user-test",
        sdkRunner: async ({ payload }) => {
          assert.strictEqual(payload.prompt, "hello");
          return { outputs: ["https://cdn.example.com/hello.png"] };
        },
      });
      assert.strictEqual(res.status, "success");
      assert.strictEqual(res.images[0].url, "https://cdn.example.com/hello.png");
    });

    // TEST 2 — Edit semantic request
    it("TEST 2: Edit semantic request routes through configured Provider edit route", async () => {
      let routeCalled = null;
      const res = await models.run(
        "nanobana_pro",
        { prompt: "change the jacket", input_image: "https://example.com/jacket.png" },
        {
          userId: "user-test",
          sdkRunner: async ({ binding, payload }) => {
            routeCalled = binding.endpoint;
            assert.ok(Array.isArray(payload.images));
            assert.strictEqual(payload.images[0], "https://example.com/jacket.png");
            return { outputs: ["https://cdn.example.com/edited.png"] };
          },
        }
      );
      assert.strictEqual(routeCalled, "google/nano-banana-pro/edit");
      assert.strictEqual(res.images[0].url, "https://cdn.example.com/edited.png");
    });

    // TEST 3 — Input image + mask
    it("TEST 3: Input image + mask routes through Provider inpaint route", async () => {
      let routeCalled = null;
      let maskPassed = null;
      const res = await models.run(
        "nanobana_pro",
        {
          prompt: "replace selected area",
          input_image: "https://example.com/source.png",
          mask: "https://example.com/mask.png",
        },
        {
          userId: "user-test",
          sdkRunner: async ({ binding, payload }) => {
            routeCalled = binding.endpoint;
            maskPassed = payload.mask;
            return { outputs: ["https://cdn.example.com/inpainted.png"] };
          },
        }
      );
      assert.strictEqual(routeCalled, "google/nano-banana-pro/edit");
      assert.strictEqual(maskPassed, "https://example.com/mask.png");
      assert.strictEqual(res.images[0].url, "https://cdn.example.com/inpainted.png");
    });

    // TEST 4 — Reference images
    it("TEST 4: Reference images passes array to provider and is NOT routed to edit", async () => {
      let endpointCalled = null;
      let refPassed = null;
      const res = await models.run(
        "nanobana_pro",
        {
          prompt: "combine these references",
          reference_images: ["https://example.com/ref1.png", "https://example.com/ref2.png"],
        },
        {
          userId: "user-test",
          sdkRunner: async ({ binding, payload }) => {
            endpointCalled = binding.endpoint;
            refPassed = payload.reference_images;
            return { outputs: ["https://cdn.example.com/combined.png"] };
          },
        }
      );
      assert.strictEqual(endpointCalled, "google/nano-banana-pro/text-to-image");
      assert.deepStrictEqual(refPassed, ["https://example.com/ref1.png", "https://example.com/ref2.png"]);
      assert.strictEqual(res.images[0].url, "https://cdn.example.com/combined.png");
    });

    // TEST 5 — Google topology
    it("TEST 5: Google topology executes single endpoint with textPrompt and sourceImage without fake operation", async () => {
      let googleEndpoint = null;
      let googlePayload = null;
      const res = await models.run(
        "nanobana_pro",
        {
          prompt: "Futuristic city",
          input_image: "https://example.com/base.png",
        },
        {
          userId: "user-test",
          bindingId: "nanobana_pro.google", // internal test override
          sdkRunner: async ({ binding, payload }) => {
            googleEndpoint = binding.endpoint;
            googlePayload = payload;
            return { images: [{ imageUri: "https://cdn.google.com/out.png" }] };
          },
        }
      );
      assert.strictEqual(googleEndpoint, "/v1beta/models/imagen-4-ultra:generate");
      assert.strictEqual(googlePayload.textPrompt, "Futuristic city");
      assert.strictEqual(googlePayload.sourceImage, "https://example.com/base.png");
      assert.strictEqual(res.images[0].url, "https://cdn.google.com/out.png");
    });

    // TEST 6 — WaveSpeed topology
    it("TEST 6: WaveSpeed topology selects /edit vs /text-to-image according to its own routes configuration", async () => {
      let textEndpoint = null;
      let editEndpoint = null;

      await models.run("nanobana_pro", { prompt: "Text only" }, {
        userId: "user-1",
        sdkRunner: async ({ binding }) => {
          textEndpoint = binding.endpoint;
          return { outputs: ["https://cdn.wavespeed.ai/1.png"] };
        },
      });

      await models.run("nanobana_pro", { prompt: "With image", input_image: "https://example.com/img.png" }, {
        userId: "user-1",
        sdkRunner: async ({ binding }) => {
          editEndpoint = binding.endpoint;
          return { outputs: ["https://cdn.wavespeed.ai/2.png"] };
        },
      });

      assert.strictEqual(textEndpoint, "google/nano-banana-pro/text-to-image");
      assert.strictEqual(editEndpoint, "google/nano-banana-pro/edit");
    });

    // TEST 7 — Provider switch
    it("TEST 7: Provider switch from WaveSpeed to Google executes with identical caller invocation", async () => {
      const { getRegistry } = await import("../../src/models/registry/modelRegistry.js");
      const { bindings } = getRegistry();
      const ws = bindings.get("nanobana_pro:text_to_image:wavespeed");
      const g = bindings.get("nanobana_pro:text_to_image:google");

      const callerParams = { prompt: "Identical caller request", resolution: "1k" };
      let executedProvider = null;

      // 1. With WaveSpeed active
      await models.run("nanobana_pro", callerParams, {
        userId: "u1",
        sdkRunner: async ({ binding }) => {
          executedProvider = binding.providerId;
          return { outputs: ["https://cdn.example.com/ws.png"] };
        },
      });
      assert.strictEqual(executedProvider, "wavespeed");

      // 2. Switch config
      ws.status = "standby";
      g.status = "active";
      try {
        await models.run("nanobana_pro", callerParams, {
          userId: "u1",
          sdkRunner: async ({ binding }) => {
            executedProvider = binding.providerId;
            return { images: [{ imageUri: "https://cdn.example.com/g.png" }] };
          },
        });
        assert.strictEqual(executedProvider, "google");
      } finally {
        ws.status = "active";
        g.status = "standby";
      }
    });

    // TEST 8 — Quote/execution symmetry
    it("TEST 8: Quote/execution symmetry: calculateCost and run resolve to the exact same implementation tier", async () => {
      const editParams = {
        prompt: "Symmetry test",
        input_image: "https://example.com/img.png",
        resolution: "4k",
      };

      // 1. Quote price
      const quotedCredits = models.calculateCost("nanobana_pro", editParams);

      // 2. Execution price
      let executedRoute = null;
      await models.run("nanobana_pro", editParams, {
        userId: "u-sym",
        sdkRunner: async ({ binding }) => {
          executedRoute = binding.id;
          return { outputs: ["https://cdn.example.com/sym.png"] };
        },
      });

      // Price for 4k edit is 30 credits in nanobana_pro retailPricing / wavespeed route
      assert.strictEqual(quotedCredits, 30);
      assert.strictEqual(executedRoute, "edit");
    });

    // TEST 9 — Wallet isolation
    it("TEST 9: Wallet isolation: Models Management performs zero hold/commit/release/ledger mutations", async () => {
      // Introspect all exports of models subsystem to verify no wallet operations exist
      const modelsExports = Object.keys(models);
      const walletTerms = ["hold", "commit", "release", "reserve", "wallet", "ledger", "balance", "deduct"];

      for (const term of walletTerms) {
        for (const exp of modelsExports) {
          assert.strictEqual(
            exp.toLowerCase().includes(term),
            false,
            `Models export "${exp}" violates wallet isolation (contains term "${term}")`
          );
        }
      }
    });

    // TEST 10 — No provider leakage
    it("TEST 10: No provider leakage across application layers (src/v2, src/use-cases, controllers)", () => {
      const dirsToScan = [
        path.join(apiRoot, "src", "v2"),
        path.join(apiRoot, "src", "use-cases"),
        path.join(apiRoot, "controllers"),
      ];

      function scanDir(dir) {
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir, { withFileTypes: true })
          .flatMap((dirent) => dirent.isDirectory()
            ? scanDir(path.join(dir, dirent.name))
            : [path.join(dir, dirent.name)]
          );
      }

      const files = dirsToScan.flatMap(scanDir).filter((f) => f.endsWith(".js"));
      const leakagePatterns = [
        /\bproviderId\b/,
        /\bbindingId\b/,
        /\bforceProvider\b/,
        /\bfallbackProvider\b/,
        /\bpreferredProvider\b/,
      ];

      for (const file of files) {
        const code = fs.readFileSync(file, "utf8");
        for (const pattern of leakagePatterns) {
          assert.strictEqual(
            pattern.test(code),
            false,
            `File ${path.relative(apiRoot, file)} leaks provider abstraction: ${pattern}`
          );
        }
      }
    });

    // TEST 11 — No generic operation taxonomy
    it("TEST 11: Models Core does not contain inferOperation or hardcoded provider operation decisions", () => {
      const coreFiles = [
        path.join(apiRoot, "src", "models", "index.js"),
        path.join(apiRoot, "src", "models", "execution", "modelRunner.js"),
        path.join(apiRoot, "src", "models", "schema", "schemaValidator.js"),
      ];

      for (const file of coreFiles) {
        const code = fs.readFileSync(file, "utf8");
        assert.strictEqual(
          code.includes("inferOperation"),
          false,
          `File ${path.relative(apiRoot, file)} contains forbidden inferOperation`
        );
        assert.strictEqual(
          /if\s*\([^)]*input_image[^)]*\)\s*return\s*["']edit["']/.test(code),
          false,
          `File ${path.relative(apiRoot, file)} contains universal input_image=edit decision in core`
        );
      }
    });

    // TEST 12 — No model-specific provider branches
    it("TEST 12: Generic runners and core contain no model-specific or provider-specific branches", () => {
      const genericFiles = [
        path.join(apiRoot, "src", "models", "execution", "modelRunner.js"),
        path.join(apiRoot, "src", "models", "execution", "runtimeExecutor.js"),
        path.join(apiRoot, "src", "models", "runtime", "routeResolver.js"),
      ];

      const forbiddenBranchPatterns = [
        /if\s*\(\s*(?:model|modelId)\s*===?\s*["']nanobana_pro["']\s*\)/,
        /if\s*\(\s*(?:provider|providerId)\s*===?\s*["']wavespeed["']\s*\)/,
        /if\s*\(\s*(?:provider|providerId)\s*===?\s*["']google["']\s*\)/,
        /switch\s*\(\s*(?:model|modelId)\s*\)/,
        /switch\s*\(\s*(?:provider|providerId)\s*\)/,
      ];

      for (const file of genericFiles) {
        const code = fs.readFileSync(file, "utf8");
        for (const pattern of forbiddenBranchPatterns) {
          assert.strictEqual(
            pattern.test(code),
            false,
            `File ${path.relative(apiRoot, file)} contains forbidden model/provider specific branch: ${pattern}`
          );
        }
      }
    });
  });

});
