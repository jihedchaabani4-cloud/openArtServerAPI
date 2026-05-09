import express from "express";
import {
    getCheckoutUrl,
    handleWebhook,
    getPurchaseHistory,
    getCreditPackages,
} from "../controllers/paymentsController.js";
import { requireAuth } from "../src/middleware/auth.js";

const router = express.Router();

// ── Public: get available credit packages ────────────────────
// GET /api/payments/packages
router.get("/packages", getCreditPackages);

// ── Public: get checkout URL (user must be logged in via cookie) ──
// POST /api/payments/checkout
// body: { variantId: "VARIANT-ID-1" }
router.post("/checkout", requireAuth, getCheckoutUrl);

// ── Webhook from Lemon Squeezy (public, no auth — secured by signature) ──
// POST /api/payments/webhook
router.post("/webhook", express.raw({ type: "application/json" }), handleWebhook);

// ── Protected: get purchase history ─────────────────────────
// GET /api/payments/history
router.get("/history", requireAuth, getPurchaseHistory);

export default router;
