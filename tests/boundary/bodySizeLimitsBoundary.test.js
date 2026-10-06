import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import app from "../../index.js";
import { supabase } from "../../lib/supabase.js";
import { redisConnection, workerRedisConnection } from "../../src/queue/redis.js";

describe("RC1.4-D2 — Body Size & Multer Limits Boundary Tests", () => {
  let server;
  let baseUrl;
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

  it("TEST D2-1: Global route rejects JSON body > 1MB with 413 and clean error code", async () => {
    // Generate a payload slightly over 1MB (~1.2MB)
    const largeString = "x".repeat(1.2 * 1024 * 1024);
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "test@example.com", password: largeString }),
    });

    assert.equal(res.status, 413, "Body > 1MB on global route must return 413");
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "PAYLOAD_TOO_LARGE");
    assert.ok(body.message, "Should have a clean error message");
  });

  it("TEST D2-2: Global route accepts normal JSON body (< 1MB)", async () => {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "test@example.com", password: "short-password" }),
    });

    // Not 413 (could be 200, 400, or 401 depending on credentials)
    assert.notEqual(res.status, 413, "Normal body should not return 413");
  });

  it("TEST D2-3: Scoped route (POST /api/v2/elements) accepts JSON body between 1MB and 15MB", async () => {
    // ~2.5MB payload representing base64 images
    const base64Data = "data:image/jpeg;base64," + "a".repeat(2.5 * 1024 * 1024);
    const res = await fetch(`${baseUrl}/api/v2/elements`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-user-id",
      },
      body: JSON.stringify({
        name: "test-element",
        sourceImages: [base64Data],
      }),
    });

    // Should NOT be rejected with 413
    assert.notEqual(res.status, 413, "2.5MB payload to scoped route must not return 413");
  });

  it("TEST D2-4: Scoped route (POST /api/v2/elements) rejects JSON body > 30MB with 413", async () => {
    // ~31MB payload
    const base64Data = "data:image/jpeg;base64," + "a".repeat(31 * 1024 * 1024);
    const res = await fetch(`${baseUrl}/api/v2/elements`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-user-id",
      },
      body: JSON.stringify({
        name: "test-element",
        sourceImages: [base64Data],
      }),
    });

    assert.equal(res.status, 413, "Body > 30MB to scoped route must return 413");
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "PAYLOAD_TOO_LARGE");
  });

  it("TEST D2-5: Payments webhook receives raw bytes and still verifies signature", async () => {
    const webhookSecret = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET || "test-lemon-squeezy-secret";
    process.env.LEMON_SQUEEZY_WEBHOOK_SECRET = webhookSecret;

    const payloadObj = {
      meta: { event_name: "order_created" },
      data: { id: "order_test_123", attributes: { order_number: 1001 } },
    };
    const rawPayload = Buffer.from(JSON.stringify(payloadObj), "utf8");
    const hmac = crypto.createHmac("sha256", webhookSecret).update(rawPayload).digest("hex");

    const res = await fetch(`${baseUrl}/api/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-signature": hmac,
      },
      body: rawPayload,
    });

    // Webhook should process without body parser corruption
    assert.notEqual(res.status, 400, "Webhook raw body must not be corrupted by body parser");
    assert.notEqual(res.status, 413, "Webhook must not return 413");
  });

  it("TEST D2-6: Multer image upload > 20MB is rejected with 413 and clean PAYLOAD_TOO_LARGE error", async () => {
    const formData = new FormData();
    const largeImageBuffer = Buffer.alloc(21 * 1024 * 1024, 0x61);
    largeImageBuffer[0] = 0xff;
    largeImageBuffer[1] = 0xd8;
    largeImageBuffer[2] = 0xff;
    const blob = new Blob([largeImageBuffer], { type: "image/jpeg" });
    formData.append("file", blob, "large-image.jpg");

    const res = await fetch(`${baseUrl}/api/assets/upload`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-user-id",
      },
      body: formData,
    });

    assert.equal(res.status, 413, "Image > 20MB should return 413");
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "PAYLOAD_TOO_LARGE");
  });

  it("TEST D2-7: Multer image upload <= 20MB is accepted (not rejected with 413)", async () => {
    const formData = new FormData();
    const imageBuffer = Buffer.alloc(100 * 1024, 0x61);
    imageBuffer[0] = 0xff;
    imageBuffer[1] = 0xd8;
    imageBuffer[2] = 0xff;
    const blob = new Blob([imageBuffer], { type: "image/jpeg" });
    formData.append("file", blob, "small-image.jpg");

    const res = await fetch(`${baseUrl}/api/assets/upload`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-user-id",
      },
      body: formData,
    });

    assert.notEqual(res.status, 413, "Image <= 20MB must not return 413");
  });

  it("TEST D2.1-1: Realistic multi-photo payload (~22MB) is accepted by scoped routes (under 30MB)", async () => {
    // 5 photos of ~3MB each = 15MB binary -> ~20.5MB base64
    const photoBase64 = "data:image/jpeg;base64," + "a".repeat(4.1 * 1024 * 1024);
    const sourceImages = [photoBase64, photoBase64, photoBase64, photoBase64, photoBase64];
    const res = await fetch(`${baseUrl}/api/v2/elements`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer test-user-id",
      },
      body: JSON.stringify({
        name: "test-element-realistic",
        sourceImages,
      }),
    });

    assert.notEqual(res.status, 413, "Realistic 5-photo payload (~21MB) must not be rejected with 413 when 30MB limit is enabled");
  });

  it("TEST D2.1-2: Image-only character route rejects non-image MIME types (e.g. video/mp4)", async () => {
    const formData = new FormData();
    const videoBuffer = Buffer.alloc(1024, 0x61);
    const blob = new Blob([videoBuffer], { type: "video/mp4" });
    formData.append("file", blob, "test-video.mp4");

    const res = await fetch(`${baseUrl}/api/characters/create`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-user-id",
      },
      body: formData,
    });

    assert.equal(res.status, 415, "Non-image upload to image-only route should return 415");
  });

  it("TEST D2.1-3: Image-only character route rejects file > 20MB directly via multer limits", async () => {
    const formData = new FormData();
    const largeBuffer = Buffer.alloc(22 * 1024 * 1024, 0x61);
    largeBuffer[0] = 0xff;
    largeBuffer[1] = 0xd8;
    largeBuffer[2] = 0xff;
    const blob = new Blob([largeBuffer], { type: "image/jpeg" });
    formData.append("file", blob, "large-photo.jpg");

    const res = await fetch(`${baseUrl}/api/characters/create`, {
      method: "POST",
      headers: {
        Authorization: "Bearer test-user-id",
      },
      body: formData,
    });

    assert.equal(res.status, 413, "File > 20MB on character route must return 413 directly");
    const body = await res.json();
    assert.equal(body.code, "PAYLOAD_TOO_LARGE");
  });
});
