import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import paymentsRouter from "../../routes/payments.js";
import { walletService } from "../../src/container.js";
import { supabase } from "../../lib/supabase.js";
import { WalletError } from "../../src/platform/billing/WalletService.js";

import { redisConnection, workerRedisConnection } from "../../src/queue/redis.js";

describe("RC1.2-S4 — Lemon Squeezy Payments Webhook Boundary Tests", () => {
  let server;
  let baseUrl;
  const WEBHOOK_SECRET = "lemon-secret-test-key-32-chars-long!!";
  let origSecret;
  let origCredit;
  let origFrom;

  let creditCalls = [];

  before(async () => {
    origSecret = process.env.LEMON_WEBHOOK_SECRET;
    process.env.LEMON_WEBHOOK_SECRET = WEBHOOK_SECRET;

    const app = express();
    // Mirror production index.js: raw body parser for webhook BEFORE global express.json
    app.use("/api/payments/webhook", express.raw({ type: "application/json" }));
    app.use(express.json({ limit: "50mb" }));
    app.use("/api/payments", paymentsRouter);

    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    process.env.LEMON_WEBHOOK_SECRET = origSecret;
    try {
      await redisConnection?.quit().catch(() => redisConnection?.disconnect());
      await workerRedisConnection?.quit().catch(() => workerRedisConnection?.disconnect());
    } catch {}
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  beforeEach(() => {
    creditCalls = [];
    origCredit = walletService?.credit;
    origFrom = supabase?.from;

    if (walletService) {
      walletService.credit = async (params) => {
        creditCalls.push(params);
        return { transactionId: "tx-123", newBalance: 150 };
      };
    }

    if (supabase) {
      supabase.from = (table) => {
        if (table === "credit_packages") {
          return {
            select: () => ({
              eq: (field, val) => ({
                maybeSingle: async () => {
                  if (field === "variant_id" && val === "variant_100") {
                    return { data: { id: "pkg_100", credits: 100 }, error: null };
                  }
                  if (field === "id" && val === "pkg_fallback") {
                    return { data: { id: "pkg_fallback", credits: 250 }, error: null };
                  }
                  return { data: null, error: null };
                },
              }),
            }),
          };
        }
        return origFrom?.call(supabase, table);
      };
    }
  });

  afterEach(() => {
    if (walletService && origCredit) {
      walletService.credit = origCredit;
    }
    if (supabase && origFrom) {
      supabase.from = origFrom;
    }
  });

  function signPayload(bodyStr, secret = WEBHOOK_SECRET) {
    return crypto.createHmac("sha256", secret).update(bodyStr).digest("hex");
  }

  it("TEST WEBHOOK-1: Request with invalid HMAC signature returns 401 and does not credit", async () => {
    const payload = JSON.stringify({
      meta: { event_name: "order_created" },
      data: { id: "order_1", attributes: { status: "paid" } },
    });

    const res = await fetch(`${baseUrl}/api/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature": "invalid_hex_signature_deadbeef",
      },
      body: payload,
    });

    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.message, "Invalid signature");
    assert.equal(creditCalls.length, 0);
  });

  it("TEST WEBHOOK-2: Valid signature on unknown event returns 200 ignored and does not credit", async () => {
    const payload = JSON.stringify({
      meta: { event_name: "subscription_resumed" },
      data: { id: "sub_1", attributes: { status: "active" } },
    });
    const sig = signPayload(payload);

    const res = await fetch(`${baseUrl}/api/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature": sig,
      },
      body: payload,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.message, "Event subscription_resumed ignored");
    assert.equal(creditCalls.length, 0);
  });

  it("TEST WEBHOOK-3: Valid signature on non-paid order returns 200 skipped and does not credit", async () => {
    const payload = JSON.stringify({
      meta: {
        event_name: "order_created",
        custom_data: { user_id: "user-alice" },
      },
      data: {
        id: "order_pending_1",
        attributes: { status: "pending" },
      },
    });
    const sig = signPayload(payload);

    const res = await fetch(`${baseUrl}/api/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature": sig,
      },
      body: payload,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.message, "Order not paid, skipped");
    assert.equal(creditCalls.length, 0);
  });

  it("TEST WEBHOOK-4: Valid signature on paid order credits wallet with referenceId and returns 200", async () => {
    const payload = JSON.stringify({
      meta: {
        event_name: "order_created",
        custom_data: { user_id: "user-alice", package_id: "pkg_100" },
      },
      data: {
        id: "998811",
        attributes: {
          status: "paid",
          first_order_item: { variant_id: "variant_100" },
        },
      },
    });
    const sig = signPayload(payload);

    const res = await fetch(`${baseUrl}/api/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature": sig,
      },
      body: payload,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.message, "Credits added successfully");

    assert.equal(creditCalls.length, 1);
    assert.equal(creditCalls[0].userId, "user-alice");
    assert.equal(creditCalls[0].amount, 100);
    assert.equal(creditCalls[0].referenceId, "ls_order_998811");
  });

  it("TEST WEBHOOK-5: Duplicate/replayed webhook returns 200 Already processed and does not double credit", async () => {
    if (walletService) {
      walletService.credit = async ({ referenceId }) => {
        const err = new WalletError(`Transaction ${referenceId} already exists (duplicate)`, "DUPLICATE_TRANSACTION");
        err.code = "DUPLICATE_TRANSACTION";
        throw err;
      };
    }

    const payload = JSON.stringify({
      meta: {
        event_name: "order_created",
        custom_data: { user_id: "user-alice", package_id: "pkg_100" },
      },
      data: {
        id: "998811",
        attributes: {
          status: "paid",
          first_order_item: { variant_id: "variant_100" },
        },
      },
    });
    const sig = signPayload(payload);

    const res = await fetch(`${baseUrl}/api/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature": sig,
      },
      body: payload,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.message, "Already processed");
  });

  it("TEST WEBHOOK-6: Payload with whitespace, escaped slashes, unicode escapes, and custom key order signed over RAW bytes", async () => {
    // Exact raw bytes with extra whitespace, escaped slashes, unicode escapes, different key order
    const rawPayloadString = '{\n  "meta":   {\n    "event_name": "order_created",\n    "custom_data": {\n      "zeta_order": "first",\n      "user_id": "\\u0075ser-alice",\n      "package_id": "pkg_100"\n    }\n  },\n  "data": {\n    "id": "998822",\n    "attributes": {\n      "status": "paid",\n      "invoice_url": "https:\\/\\/example.com\\/invoices\\/123",\n      "first_order_item": {\n        "variant_id": "variant_100"\n      }\n    }\n  }\n}';
    const rawBuffer = Buffer.from(rawPayloadString, "utf8");
    const sig = signPayload(rawBuffer);

    const res = await fetch(`${baseUrl}/api/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature": sig,
      },
      body: rawBuffer,
    });

    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.message, "Credits added successfully");
    assert.equal(creditCalls.length, 1);
    assert.equal(creditCalls[0].userId, "user-alice");
  });

  it("TEST WEBHOOK-7: Webhook rejects non-Buffer body without falling back to JSON.stringify", async () => {
    const fakeReq = {
      body: { meta: { event_name: "order_created" } },
      headers: { "x-signature": "dummy" },
    };
    let statusCode = null;
    let responseBody = null;
    const fakeRes = {
      status(code) {
        statusCode = code;
        return this;
      },
      json(data) {
        responseBody = data;
        return this;
      },
    };

    const { handleWebhook } = await import("../../controllers/paymentsController.js");
    await handleWebhook(fakeReq, fakeRes);

    assert.equal(statusCode, 400);
    assert.equal(responseBody.ok, false);
    assert.match(responseBody.message, /buffer/i);
  });
});
