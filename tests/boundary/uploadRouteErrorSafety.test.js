process.env.NODE_ENV = "test";

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import { supabase } from "#shared/db/supabase.js";
import { assetUploadService, workflowService } from "../../src/container.js";
import { assetsRouter } from "#media/api";
import { mediaIngestRouter } from "#media/api";

describe("Upload routes — safe public error bodies", () => {
    let server;
    let baseUrl;
    let origGetUser;
    let origUploadAsset;

    function stubService(err) {
        assetUploadService.uploadAsset = async () => {
            throw err;
        };
    }

    before(async () => {
        origGetUser = supabase?.auth?.getUser;
        if (supabase?.auth) {
            supabase.auth.getUser = async (token) => {
                if (token && token.startsWith("test-valid-user")) {
                    return { data: { user: { id: token } }, error: null };
                }
                return { data: { user: null }, error: new Error("Invalid token") };
            };
        }
        origUploadAsset = assetUploadService.uploadAsset;

        const app = express();
        app.use(express.json());
        app.use("/api/assets", assetsRouter);
        app.use("/api/media", mediaIngestRouter);

        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        baseUrl = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        if (origUploadAsset) assetUploadService.uploadAsset = origUploadAsset;
        if (supabase?.auth && origGetUser) supabase.auth.getUser = origGetUser;
        if (server) await new Promise((resolve) => server.close(resolve));
    });

    const LEAK_EVIDENCE = "ECONNREFUSED secret-key storage quota exhausted table \"project\"";

    it("masks internal 5xx failure details on /api/media/ingest", async () => {
        stubService(Object.assign(new Error(LEAK_EVIDENCE), { statusCode: 500 }));
        const res = await fetch(`${baseUrl}/api/media/ingest`, {
            method: "POST",
            headers: { "authorization": "Bearer test-valid-user-x", "content-type": "application/json" },
            body: JSON.stringify({ source: "https://example.test/image.png" }),
        });
        assert.equal(res.status, 500);
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.equal(body.error, "Internal server error");
        assert.ok(!JSON.stringify(body).includes("ECONNREFUSED"));
        assert.ok(!JSON.stringify(body).includes("secret-key"));
    });

    it("masks internal 5xx failure details on /api/assets/upload", async () => {
        stubService(Object.assign(new Error(LEAK_EVIDENCE), { statusCode: 500 }));
        const res = await fetch(`${baseUrl}/api/assets/upload`, {
            method: "POST",
            headers: { "authorization": "Bearer test-valid-user-x", "content-type": "application/json" },
            body: JSON.stringify({ source: "https://example.test/image.png" }),
        });
        assert.equal(res.status, 500);
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.equal(body.message, "Internal server error");
        assert.equal(body.error, "Internal server error");
        assert.ok(!JSON.stringify(body).includes("ECONNREFUSED"));
    });

    it("keeps intentional 4xx validation messages public on /api/media/ingest", async () => {
        stubService(Object.assign(new Error("project_id is required: the user has no project available for this upload."), {
            statusCode: 400,
            errorCode: "VALIDATION_ERROR",
        }));
        const res = await fetch(`${baseUrl}/api/media/ingest`, {
            method: "POST",
            headers: { "authorization": "Bearer test-valid-user-x", "content-type": "application/json" },
            body: JSON.stringify({ source: "https://example.test/image.png" }),
        });
        assert.equal(res.status, 400);
        const body = await res.json();
        assert.match(body.error, /project_id is required/);
    });

    it("keeps 404 not-found responses on /api/assets/upload without masking", async () => {
        stubService(Object.assign(new Error("Project not found"), {
            statusCode: 404,
            errorCode: "NOT_FOUND",
        }));
        const res = await fetch(`${baseUrl}/api/assets/upload`, {
            method: "POST",
            headers: { "authorization": "Bearer test-valid-user-x", "content-type": "application/json" },
            body: JSON.stringify({ source: "https://example.test/image.png" }),
        });
        assert.equal(res.status, 404);
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.match(body.message, /not found/i);
        assert.equal(body.errorCode, "NOT_FOUND");
    });

    it("passes the errorCode of known 4xx service errors through to the client", async () => {
        stubService(Object.assign(new Error("Invalid storage folder \"../evil\": expected a single segment of [A-Za-z0-9_-]."), {
            statusCode: 400,
            errorCode: "VALIDATION_ERROR",
        }));
        const res = await fetch(`${baseUrl}/api/assets/upload`, {
            method: "POST",
            headers: { "authorization": "Bearer test-valid-user-x", "content-type": "application/json" },
            body: JSON.stringify({ source: "https://example.test/image.png" }),
        });
        const body = await res.json();
        assert.equal(res.status, 400);
        assert.equal(body.errorCode, "VALIDATION_ERROR");
        assert.match(body.error, /Invalid storage folder/);
    });

    it("masks internal 5xx failure details on DELETE /api/assets/:id", async () => {
        const origDelete = workflowService.deleteMedia;
        workflowService.deleteMedia = async () => {
            throw Object.assign(new Error(LEAK_EVIDENCE), { statusCode: 500 });
        };
        try {
            const res = await fetch(`${baseUrl}/api/assets/media-neutral-1`, {
                method: "DELETE",
                headers: { "authorization": "Bearer test-valid-user-x" },
            });
            assert.equal(res.status, 500);
            const body = await res.json();
            assert.equal(body.ok, false);
            assert.equal(body.error, "Internal server error");
            assert.equal(body.errorCode, "INTERNAL_ERROR");
            assert.ok(!JSON.stringify(body).includes("ECONNREFUSED"));
            assert.ok(!JSON.stringify(body).includes("secret-key"));
        } finally {
            workflowService.deleteMedia = origDelete;
        }
    });

    it("preserves the 404 contract on DELETE /api/assets/:id", async () => {
        const origDelete = workflowService.deleteMedia;
        workflowService.deleteMedia = async () => {
            throw Object.assign(new Error("Media not found."), { statusCode: 404, errorCode: "NOT_FOUND" });
        };
        try {
            const res = await fetch(`${baseUrl}/api/assets/media-neutral-1`, {
                method: "DELETE",
                headers: { "authorization": "Bearer test-valid-user-x" },
            });
            assert.equal(res.status, 404);
            const body = await res.json();
            assert.equal(body.ok, false);
            assert.match(body.error, /not found/i);
            assert.equal(body.errorCode, "NOT_FOUND");
        } finally {
            workflowService.deleteMedia = origDelete;
        }
    });
});
