import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import app from "../../index.js";
import { supabase } from "#shared/db/supabase.js";
import { redisConnection, workerRedisConnection } from "#shared";

describe("STEP 3: Multipart 2 files route-level error safety boundary test", () => {
  let server;
  let baseUrl;
  let origGetUser;

  before(async () => {
    origGetUser = supabase?.auth?.getUser;
    if (supabase?.auth) {
      supabase.auth.getUser = async (token) => {
        if (token && token.startsWith("test-valid-user")) {
          return { data: { user: { id: "test-valid-user-1" } }, error: null };
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
    if (supabase?.auth && origGetUser) {
      supabase.auth.getUser = origGetUser;
    }
    try {
      const { rateLimitRedisConnection } = await import("#shared");
      await rateLimitRedisConnection?.quit().catch(() => rateLimitRedisConnection?.disconnect());
    } catch {}
    try {
      await redisConnection?.quit().catch(() => redisConnection?.disconnect());
      await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
    } catch {}
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("POST /api/assets/upload with 2 files receives a clean 4xx error (not 500, no crash)", async () => {
    const formData = new FormData();
    formData.append("file", new Blob([Buffer.from("file 1 content")], { type: "image/png" }), "file1.png");
    formData.append("file", new Blob([Buffer.from("file 2 content")], { type: "image/png" }), "file2.png");
    formData.append("project_id", "00000000-0000-0000-0000-000000000001");

    const res = await fetch(`${baseUrl}/api/assets/upload`, {
      method: "POST",
      headers: { Authorization: "Bearer test-valid-user-1" },
      body: formData,
    });

    const body = await res.json().catch(() => ({}));
    console.log(`[TEST RESULT] Status: ${res.status}, Body:`, JSON.stringify(body));

    // Asserts clean 4xx (400 Bad Request or similar) instead of 500 Internal Server Error
    assert.ok(
      res.status >= 400 && res.status < 500,
      `Expected clean 4xx JSON error, but got HTTP ${res.status}: ${JSON.stringify(body)}`
    );
  });
});
