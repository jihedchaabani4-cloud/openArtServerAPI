/**
 * System 3: Billing & Wallet — Public HTTP Gateway (Rule 1, Rule 13)
 *
 * @description Sealed Express gateway mounting ONLY paymentsRouter and walletRouter.
 */

import express from "express";
import { getWalletService } from "../internal/services/serviceAccessor.js";
import { requireAuth, walletRateLimit } from "#identity/tools";
import {
    getCheckoutUrl,
    handleWebhook,
    getPurchaseHistory,
    getCreditPackages,
} from "../internal/controllers/paymentsController.js";
import {
    getBalance,
    getTransactions,
    getPrice,
} from "../internal/controllers/walletController.js";

// ── Payments Router ────────────────────────────────────────────────
export const paymentsRouter = express.Router();
paymentsRouter.get("/packages", getCreditPackages);
paymentsRouter.post("/checkout", requireAuth, getCheckoutUrl);
paymentsRouter.post("/webhook", express.raw({ type: "application/json" }), handleWebhook);
paymentsRouter.get("/history", requireAuth, getPurchaseHistory);

// ── Wallet Router ──────────────────────────────────────────────────
export const walletRouter = express.Router();
walletRouter.use((req, _res, next) => {
    if (!req.walletService) req.walletService = getWalletService();
    next();
});
walletRouter.use(requireAuth);
walletRouter.use(walletRateLimit({ max: 30, windowSec: 60 }));
walletRouter.get("/balance", getBalance);
walletRouter.get("/transactions", getTransactions);
walletRouter.get("/price", getPrice);
