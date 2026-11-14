/**
 * Main Router Cutover & Architecture Integration Tests (Partie 10)
 *
 * Verifies that src/api/routes.js is exclusively mounted via the 8 Business Systems'
 * public/api.js gateways with zero route regressions.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import apiRouter from "../../src/api/routes.js";
import { extractRoutes } from "../../scripts/dump-routes.js";

describe("Main Router Cutover — 8 Business Systems Gateway Architecture", () => {
    it("should exclusively import from the 8 systems' #<system>/api gateways in src/api/routes.js", () => {
        const routesFilePath = path.resolve(process.cwd(), "src/api/routes.js");
        const content = fs.readFileSync(routesFilePath, "utf8");

        // Verify imports from all 8 systems
        assert.match(content, /from ['"]#generation\/api['"]/);
        assert.match(content, /from ['"]#models\/api['"]/);
        assert.match(content, /from ['"]#billing\/api['"]/);
        assert.match(content, /from ['"]#media\/api['"]/);
        assert.match(content, /from ['"]#identity\/api['"]/);
        assert.match(content, /from ['"]#characters\/api['"]/);
        assert.match(content, /from ['"]#elements\/api['"]/);
        assert.match(content, /from ['"]#workspace\/api['"]/);

        // Verify no business router is imported from ../../routes/
        const legacyBusinessRouteImports = [
            "../../routes/workflows.js",
            "../../routes/images.js",
            "../../routes/video.js",
            "../../routes/characters.js",
            "../../routes/projects.js",
            "../../routes/folders.js",
            "../../routes/modelsRoute.js",
            "../../routes/assets.js",
            "../../routes/authRoutes.js",
            "../../routes/prompt.js",
            "../../routes/payments.js",
            "../../routes/wallet.js",
            "../../routes/admin.js",
            "../../routes/v2/workflows.js",
            "../../routes/elementRoutes.js",
            "../../routes/mediaIngestRoutes.js",
            "../../routes/trash.js",
        ];

        for (const legacyPath of legacyBusinessRouteImports) {
            assert.ok(
                !content.includes(legacyPath),
                `src/api/routes.js should not import legacy route: ${legacyPath}`
            );
        }
    });

    it("should export a valid Express router containing all 86 canonical routes", () => {
        assert.ok(apiRouter, "apiRouter must be defined");
        assert.equal(typeof apiRouter, "function", "apiRouter must be an Express router function");
        assert.ok(Array.isArray(apiRouter.stack), "apiRouter must have a router layer stack");

        const routes = extractRoutes(apiRouter, "/api");
        assert.equal(routes.length, 86, "All 86 routes must be preserved without loss");

        // Verify key paths across all 8 systems
        const paths = routes.map((r) => r.path);
        assert.ok(paths.includes("/api/images/generated"), "System 1 image generation present");
        assert.ok(paths.includes("/api/video/generated"), "System 1 video generation present");
        assert.ok(paths.includes("/api/models"), "System 2 models catalog present");
        assert.ok(paths.includes("/api/wallet/balance"), "System 3 wallet balance present");
        assert.ok(paths.includes("/api/payments/packages"), "System 3 credit packages present");
        assert.ok(paths.includes("/api/media/ingest"), "System 4 media ingestion present");
        assert.ok(paths.includes("/api/auth/login"), "System 5 auth login present");
        assert.ok(paths.includes("/api/characters"), "System 6 characters present");
        assert.ok(paths.includes("/api/v2/elements"), "System 7 elements present");
        assert.ok(paths.includes("/api/projects"), "System 8 workspace projects present");
    });
});
