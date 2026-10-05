import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import express from "express";
import characterRouter from "../../routes/characters.js";
import elementRouter from "../../routes/elementRoutes.js";
import { characterService, elementService } from "../../src/container.js";
import { redisConnection, workerRedisConnection } from "../../src/queue/redis.js";

import { supabase } from "../../lib/supabase.js";

describe("RC1.3-W4 — Free AI/Vision Rate Limiting Boundary Tests", () => {
  let server;
  let baseUrl;
  let origCharGenDesc;
  let origElemAnalyze;
  let origGetUser;

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

    const app = express();
    app.use(express.json());

    app.use("/api/characters", characterRouter);
    app.use("/api/v2/elements", elementRouter);

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
      await redisConnection?.quit().catch(() => redisConnection?.disconnect());
      await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
    } catch {}
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  beforeEach(() => {
    origCharGenDesc = characterService?.generateDescription;
    origElemAnalyze = elementService?.analyzeElement;

    if (characterService) {
      characterService.generateDescription = async () => ({
        description: "A futuristic AI character prompt",
        traits: ["neon", "cyber"],
      });
    }

    if (elementService) {
      elementService.analyzeElement = async () => ({
        analysis: "Sample element analysis output",
        suggestedPrompt: "Golden metallic wings",
      });
    }
  });

  afterEach(() => {
    if (characterService && origCharGenDesc) {
      characterService.generateDescription = origCharGenDesc;
    }
    if (elementService && origElemAnalyze) {
      elementService.analyzeElement = origElemAnalyze;
    }
  });

  it("TEST W4-1: POST /api/characters/generate-description returns 200 normal, 429 when >10/min, scoped per user", async () => {
    const userA = "user-rl-char-a";
    const userB = "user-rl-char-b";

    // 10 requests should succeed (default 10/min)
    for (let i = 1; i <= 10; i++) {
      const res = await fetch(`${baseUrl}/api/characters/generate-description`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userA}`,
        },
        body: JSON.stringify({ concept: "cyberpunk detective" }),
      });
      assert.equal(res.status, 200, `Request ${i} for user A should succeed with 200`);
      const body = await res.json();
      assert.equal(body.ok, true);
    }

    // 11th request for user A must be blocked with 429
    const resBlocked = await fetch(`${baseUrl}/api/characters/generate-description`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userA}`,
      },
      body: JSON.stringify({ concept: "cyberpunk detective" }),
    });
    assert.equal(resBlocked.status, 429, "11th request for user A should return 429");
    const blockedBody = await resBlocked.json();
    assert.equal(blockedBody.ok, false);
    assert.equal(blockedBody.code, "RATE_LIMIT_EXCEEDED");
    assert.ok(resBlocked.headers.has("retry-after"), "Must include Retry-After header");

    // User B should still be allowed (rate limit is per-user)
    const resUserB = await fetch(`${baseUrl}/api/characters/generate-description`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userB}`,
      },
      body: JSON.stringify({ concept: "cyberpunk detective" }),
    });
    assert.equal(resUserB.status, 200, "User B should succeed with 200");
  });

  it("TEST W4-2: POST /api/v2/elements/analyze returns 200 normal, 429 when >10/min, scoped per user", async () => {
    const userX = "user-rl-elem-x";
    const userY = "user-rl-elem-y";

    // 10 requests should succeed (default 10/min)
    for (let i = 1; i <= 10; i++) {
      const res = await fetch(`${baseUrl}/api/v2/elements/analyze`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${userX}`,
        },
        body: JSON.stringify({
          elementName: "Silver Blade",
          imageUrls: ["https://example.com/blade.png"],
        }),
      });
      assert.equal(res.status, 200, `Request ${i} for user X should succeed with 200`);
      const body = await res.json();
      assert.equal(body.status, "success");
    }

    // 11th request for user X must be blocked with 429
    const resBlocked = await fetch(`${baseUrl}/api/v2/elements/analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userX}`,
      },
      body: JSON.stringify({
        elementName: "Silver Blade",
        imageUrls: ["https://example.com/blade.png"],
      }),
    });
    assert.equal(resBlocked.status, 429, "11th request for user X should return 429");
    const blockedBody = await resBlocked.json();
    assert.equal(blockedBody.ok, false);
    assert.equal(blockedBody.code, "RATE_LIMIT_EXCEEDED");
    assert.ok(resBlocked.headers.has("retry-after"), "Must include Retry-After header");

    // User Y should still be allowed
    const resUserY = await fetch(`${baseUrl}/api/v2/elements/analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${userY}`,
      },
      body: JSON.stringify({
        elementName: "Silver Blade",
        imageUrls: ["https://example.com/blade.png"],
      }),
    });
    assert.equal(resUserY.status, 200, "User Y should succeed with 200");
  });
});
