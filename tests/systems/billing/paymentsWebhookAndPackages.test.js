import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import http from "node:http";
import express from "express";
import { paymentsRouter } from "#billing/api";
import { toPublicPackage, PUBLIC_PACKAGE_FIELDS } from "../../../src/systems/billing/internal/controllers/payments/paymentsUtils.js";
import { walletService } from "../../../src/container.js";
import { supabase } from "#shared/db/supabase.js";
import { WalletError } from "#billing/tools";
import { redisConnection, workerRedisConnection } from "#shared/redis";

// ─── Source: paymentsWebhookBoundary.test.js ───
{
describe("RC1.2-S4 — Lemon Squeezy Payments Webhook Boundary Tests", () => {
  let server;
  let baseUrl;
  const WEBHOOK_SECRET = "lemon-secret-test-key-32-chars-long!!"; // gate:allow-secret
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

    const { handleWebhook } = await import("../../../src/systems/billing/internal/controllers/paymentsController.js");
    await handleWebhook(fakeReq, fakeRes);

    assert.equal(statusCode, 400);
    assert.equal(responseBody.ok, false);
    assert.match(responseBody.message, /buffer/i);
  });

  it("TEST WEBHOOK-8: Webhook returns HTTP 500 when credit() fails closed with BillingConfigurationError", async () => {
    const { BillingConfigurationError } = await import("#billing/tools");
    walletService.credit = async () => {
      throw new BillingConfigurationError("[WalletService] RPC credit_wallet missing (PGRST202 / schema cache): fail closed");
    };

    const payload = {
      meta: {
        event_name: "order_created",
        custom_data: { user_id: "user-webhook-err", package_id: "pkg_fail_closed" },
      },
      data: {
        id: "order_99999",
        attributes: {
          status: "paid",
          first_order_item: { variant_id: "variant_100" },
        },
      },
    };
    const rawBuffer = Buffer.from(JSON.stringify(payload));
    const sig = signPayload(rawBuffer);

    const res = await fetch(`${baseUrl}/api/payments/webhook`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature": sig,
      },
      body: rawBuffer,
    });

    assert.equal(res.status, 500, "Webhook must return HTTP 500 when credit() fails closed so payment provider retries");
    const body = await res.json();
    assert.equal(body.ok, false);
  });
});
}

// ─── Source: paymentsUtils.test.js ───
{
describe("PaymentsUtils — toPublicPackage Allowlist (Commit 1a-3)", () => {
    const legacyBlocklist = (pkg) => {
        const sensitive = new Set(["variant_id", "checkout_url"]);
        return Object.fromEntries(
            Object.entries(pkg).filter(([key]) => !sensitive.has(key))
        );
    };

    const fullPackage = {
        id: "pkg-1",
        label: "Starter Pack",
        credits: 100,
        price: 9.99,
        currency: "USD",
        yearly_price: null,
        variant_id: "var_12345",
        checkout_url: "https://lemon.squeezy/checkout/123",
        popular: false,
        is_trial: false,
        is_active: true,
        sort_order: 1,
        description: "Best for starters",
        features: ["feature 1", "feature 2"],
        plan_type: "one_time",
        created_at: "2026-10-01T00:00:00Z",
        updated_at: "2026-10-01T00:00:00Z",
    };

    it("matches legacy blocklist output for standard schema fields", () => {
        const expected = legacyBlocklist(fullPackage);
        const actual = toPublicPackage(fullPackage);

        assert.deepEqual(actual, expected);
        assert.equal(actual.variant_id, undefined);
        assert.equal(actual.checkout_url, undefined);
        assert.equal(actual.id, "pkg-1");
        assert.equal(actual.credits, 100);
    });

    it("drops unknown extra columns that legacy blocklist would have leaked", () => {
        const packageWithExtraColumns = {
            ...fullPackage,
            admin_profit_margin: 0.45,
            secret_billing_tag: "INTERNAL_ONLY",
            unexpected_database_field: "SHOULD_NOT_LEAK",
        };

        const leakedByLegacy = legacyBlocklist(packageWithExtraColumns);
        assert.equal(leakedByLegacy.admin_profit_margin, 0.45, "Legacy blocklist leaks unknown columns");

        const actual = toPublicPackage(packageWithExtraColumns);
        assert.equal(actual.admin_profit_margin, undefined, "Allowlist drops admin_profit_margin");
        assert.equal(actual.secret_billing_tag, undefined, "Allowlist drops secret_billing_tag");
        assert.equal(actual.unexpected_database_field, undefined, "Allowlist drops unexpected_database_field");
        assert.equal(actual.variant_id, undefined, "Allowlist drops variant_id");
        assert.equal(actual.checkout_url, undefined, "Allowlist drops checkout_url");
    });

    it("handles null, undefined, and non-object inputs safely", () => {
        assert.deepEqual(toPublicPackage(null), {});
        assert.deepEqual(toPublicPackage(undefined), {});
        assert.deepEqual(toPublicPackage("invalid"), {});
        assert.deepEqual(toPublicPackage(123), {});
    });

    it("PUBLIC_PACKAGE_FIELDS is frozen and contains all expected public fields", () => {
        assert.ok(Object.isFrozen(PUBLIC_PACKAGE_FIELDS));
        assert.ok(PUBLIC_PACKAGE_FIELDS.includes("id"));
        assert.ok(PUBLIC_PACKAGE_FIELDS.includes("label"));
        assert.ok(PUBLIC_PACKAGE_FIELDS.includes("credits"));
        assert.ok(PUBLIC_PACKAGE_FIELDS.includes("price"));
        assert.ok(PUBLIC_PACKAGE_FIELDS.includes("sort_order"));
        assert.ok(PUBLIC_PACKAGE_FIELDS.includes("is_active"));
        assert.ok(!PUBLIC_PACKAGE_FIELDS.includes("variant_id"));
        assert.ok(!PUBLIC_PACKAGE_FIELDS.includes("checkout_url"));
    });
});
}
