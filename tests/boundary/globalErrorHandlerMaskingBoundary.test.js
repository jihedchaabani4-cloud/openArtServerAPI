import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import app from "../../index.js";
import { supabase } from "#shared/db/supabase.js";
import { redisConnection, workerRedisConnection } from "#shared";
import { workflowService } from "../../src/container.js";

describe("Boundary — global error handler never leaks internal 5xx messages", () => {
    let server;
    let baseUrl;
    let origGetUser;
    let origMoveToFolder;

    before(async () => {
        origGetUser = supabase?.auth?.getUser;
        if (supabase?.auth) {
            supabase.auth.getUser = async (token) => {
                if (token) {
                    return { data: { user: { id: token } }, error: null };
                }
                return { data: { user: null }, error: new Error("Invalid token") };
            };
        }

        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const { port } = server.address();
        baseUrl = `http://127.0.0.1:${port}`;
    });

    after(async () => {
        workflowService.moveToFolder = origMoveToFolder;
        if (supabase?.auth && origGetUser) {
            supabase.auth.getUser = origGetUser;
        }
        try {
            await redisConnection?.quit().catch(() => redisConnection?.disconnect());
            await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
        } catch {}
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
    });

    it("masks an unexpected 5xx passed through next(err): no internal message, generic errorCode", async () => {
        const LEAK_EVIDENCE = 'connect ECONNREFUSED 10.0.0.4:5432 secret-key="sk-internal-77"';
        origMoveToFolder = workflowService.moveToFolder;
        workflowService.moveToFolder = async () => {
            throw Object.assign(new Error(LEAK_EVIDENCE), { statusCode: 502 });
        };
        const res = await fetch(`${baseUrl}/api/assets/asset-neutral-1/folder`, {
            method: "PATCH",
            headers: { "authorization": "Bearer test-valid-user-x", "content-type": "application/json" },
            body: JSON.stringify({ folderId: null }),
        });
        assert.equal(res.status, 502);
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.equal(body.message, "Internal server error");
        assert.equal(body.errorCode, "INTERNAL_ERROR");
        const serialized = JSON.stringify(body);
        assert.ok(!serialized.includes("ECONNREFUSED"), "internal connection details leaked");
        assert.ok(!serialized.includes("sk-internal-77"), "secret-like value leaked");
    });

    it("preserves the public 4xx contract through next(err): message and errorCode stay visible", async () => {
        origMoveToFolder = workflowService.moveToFolder;
        workflowService.moveToFolder = async () => {
            throw Object.assign(new Error("Asset not found."), {
                statusCode: 404,
                code: "NOT_FOUND",
            });
        };
        const res = await fetch(`${baseUrl}/api/assets/asset-neutral-1/folder`, {
            method: "PATCH",
            headers: { "authorization": "Bearer test-valid-user-x", "content-type": "application/json" },
            body: JSON.stringify({ folderId: null }),
        });
        assert.equal(res.status, 404);
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.match(body.message, /not found/i);
        assert.equal(body.errorCode, "NOT_FOUND");
    });

    it("preserves the intentional 503 retry contract (message + Retry-After) with a public errorCode", async () => {
        origMoveToFolder = workflowService.moveToFolder;
        workflowService.moveToFolder = async () => {
            throw Object.assign(
                new Error("Server upload capacity temporarily exceeded. Please retry shortly."),
                { statusCode: 503, code: "SERVICE_UNAVAILABLE", retryAfter: 5 }
            );
        };
        const res = await fetch(`${baseUrl}/api/assets/asset-neutral-1/folder`, {
            method: "PATCH",
            headers: { "authorization": "Bearer test-valid-user-x", "content-type": "application/json" },
            body: JSON.stringify({ folderId: null }),
        });
        assert.equal(res.status, 503);
        assert.equal(res.headers.get("retry-after"), "5");
        const body = await res.json();
        assert.equal(body.ok, false);
        assert.match(body.message, /retry shortly/i);
        assert.equal(body.errorCode, "SERVICE_UNAVAILABLE");
    });
});
