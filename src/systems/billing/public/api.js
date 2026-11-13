/**
 * System 3: Billing & Wallet — Public HTTP Gateway (Rule 1, Rule 13)
 *
 * @description Isolates all Express routing, request validation, and HTTP serialization
 * for billing and wallet endpoints.
 */

import express from "express";
import { z } from "zod";
import { createLogger } from "#shared";
import {
    getWalletService,
    getCreditPackageRepository,
    WalletError,
    BillingError,
} from "./tools.js";
import { requireAuth } from "../../../middleware/auth.js";
import { requireAdmin } from "#platform/identity";
import { walletRateLimit } from "../../../middleware/walletRateLimit.js";
import {
    getCheckoutUrl,
    handleWebhook,
    getPurchaseHistory,
    getCreditPackages,
} from "../../../../controllers/paymentsController.js";
import {
    getBalance,
    getTransactions,
    getPrice,
} from "../../../../controllers/walletController.js";
import {
    adminCredit,
    getAdminWallet,
    getLatestReconciliation,
    updatePricingRule,
    reloadModels,
} from "../../../../controllers/adminController.js";

const walletLogger = createLogger("wallet_api");

const TransactionsQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    before: z.string().datetime({ offset: true }).optional(),
    beforeId: z.string().uuid().optional(),
});

const VALID_OPERATION_TYPES = [
    "IMAGE_GENERATION",
    "CHARACTER_SHEET",
    "VIDEO_GENERATION",
];
const VALID_QUALITY_TIERS = ["standard", "hd", "4k"];

const PriceQuerySchema = z.object({
    modelKey: z.string().min(1),
    operationType: z.enum(VALID_OPERATION_TYPES),
    qualityTier: z.enum(VALID_QUALITY_TIERS).default("standard"),
});

function walletErrorToHttp(err) {
    const codeMap = {
        WALLET_NOT_FOUND: 404,
        INSUFFICIENT_FUNDS: 402,
        DUPLICATE_TRANSACTION: 409,
        INVALID_METADATA: 400,
        INVALID_TRANSITION: 409,
        CONFLICT: 409,
    };
    return codeMap[err.code] || 500;
}

export function createBillingRouter({
    walletService = null,
    pricingService = null,
    creditPackageRepo = null,
} = {}) {
    const router = express.Router();

    const resolveWallet = (req) => req.walletService || walletService || getWalletService();
    const resolvePricing = (req) => req.pricingService || pricingService;
    const resolvePackageRepo = (req) => req.creditPackageRepo || creditPackageRepo || getCreditPackageRepository();

    // GET /balance — current credit balance
    router.get("/balance", async (req, res) => {
        const start = Date.now();
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ error: "UNAUTHORIZED", message: "User is not authenticated" });
        }

        try {
            const service = resolveWallet(req);
            const balance = await service.getBalance(userId);

            walletLogger.info({
                operation: "get-balance",
                status: "success",
                userId,
                durationMs: Date.now() - start,
            }, "Balance fetched");

            return res.json({ balance, userId });
        } catch (err) {
            walletLogger.error({
                operation: "get-balance",
                status: "error",
                userId,
                error: err.message,
                code: err.code,
                durationMs: Date.now() - start,
            }, "Failed to fetch balance");

            if (err instanceof WalletError || err instanceof BillingError) {
                return res.status(walletErrorToHttp(err)).json({ error: err.code, message: err.message });
            }
            return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to fetch balance." });
        }
    });

    // GET /transactions — paginated transaction history
    router.get("/transactions", async (req, res) => {
        const start = Date.now();
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ error: "UNAUTHORIZED", message: "User is not authenticated" });
        }

        const parsed = TransactionsQuerySchema.safeParse(req.query);
        if (!parsed.success) {
            return res.status(400).json({
                error: "VALIDATION_ERROR",
                message: parsed.error.issues.map((i) => i.message).join("; "),
            });
        }

        const { limit, before, beforeId } = parsed.data;

        try {
            const service = resolveWallet(req);
            const result = await service.getTransactions(userId, limit, before, beforeId);

            walletLogger.info({
                operation: "get-transactions",
                status: "success",
                userId,
                limit,
                count: result.transactions?.length || 0,
                durationMs: Date.now() - start,
            }, "Transactions fetched");

            return res.json(result);
        } catch (err) {
            walletLogger.error({
                operation: "get-transactions",
                status: "error",
                userId,
                error: err.message,
                code: err.code,
                durationMs: Date.now() - start,
            }, "Failed to fetch transactions");

            if (err instanceof WalletError || err instanceof BillingError) {
                return res.status(walletErrorToHttp(err)).json({ error: err.code, message: err.message });
            }
            return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to fetch transactions." });
        }
    });

    // GET /price — credit cost for model/operation/quality
    router.get("/price", async (req, res) => {
        const start = Date.now();
        const userId = req.user?.id;

        const parsed = PriceQuerySchema.safeParse(req.query);
        if (!parsed.success) {
            return res.status(400).json({
                error: "VALIDATION_ERROR",
                message: parsed.error.issues.map((i) => i.message).join("; "),
            });
        }

        const { modelKey, operationType, qualityTier } = parsed.data;
        const pService = resolvePricing(req);

        if (!pService || typeof pService.getPrice !== "function") {
            return res.status(503).json({ error: "PRICING_UNAVAILABLE", message: "Pricing service is not configured" });
        }

        try {
            const result = await pService.getPrice(modelKey, operationType, qualityTier);

            walletLogger.info({
                operation: "get-price",
                status: "success",
                userId,
                modelKey,
                operationType,
                qualityTier,
                cached: result.cached,
                durationMs: Date.now() - start,
            }, "Price calculated");

            return res.json(result);
        } catch (err) {
            walletLogger.error({
                operation: "get-price",
                status: "error",
                userId,
                modelKey,
                error: err.message,
                code: err.code,
                durationMs: Date.now() - start,
            }, "Failed to calculate price");

            if (err.code === "PRICING_NOT_FOUND") {
                return res.status(404).json({ error: "PRICING_NOT_FOUND", message: err.message });
            }
            return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to fetch pricing." });
        }
    });

    // GET /packages — available credit packages
    router.get("/packages", async (req, res) => {
        const start = Date.now();
        try {
            const repo = resolvePackageRepo(req);
            const packages = await repo.listActivePackages();

            walletLogger.info({
                operation: "list-packages",
                status: "success",
                count: packages.length,
                durationMs: Date.now() - start,
            }, "Credit packages listed");

            return res.json(packages);
        } catch (err) {
            walletLogger.error({
                operation: "list-packages",
                status: "error",
                error: err.message,
                durationMs: Date.now() - start,
            }, "Failed to list credit packages");

            return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to list credit packages." });
        }
    });

    return router;
}

const defaultBillingRouter = createBillingRouter();

// ── Payments Router ────────────────────────────────────────────────
export const paymentsRouter = express.Router();
paymentsRouter.get("/packages", getCreditPackages);
paymentsRouter.post("/checkout", requireAuth, getCheckoutUrl);
paymentsRouter.post("/webhook", express.raw({ type: "application/json" }), handleWebhook);
paymentsRouter.get("/history", requireAuth, getPurchaseHistory);

// ── Wallet Router ──────────────────────────────────────────────────
export const walletRouter = express.Router();
walletRouter.use(async (req, _res, next) => {
    if (!req.walletService) req.walletService = getWalletService();
    if (!req.pricingService) {
        try {
            const container = await import("../../../container.js");
            req.pricingService = container.pricingService;
        } catch {}
    }
    next();
});
walletRouter.use(requireAuth);
walletRouter.use(walletRateLimit({ max: 30, windowSec: 60 }));
walletRouter.get("/balance", getBalance);
walletRouter.get("/transactions", getTransactions);
walletRouter.get("/price", getPrice);

// ── Admin Router ───────────────────────────────────────────────────
export const adminRouter = express.Router();
adminRouter.use(async (req, _res, next) => {
    if (!req.walletService) req.walletService = getWalletService();
    if (!req.pricingService || !req.redisConnection) {
        try {
            const container = await import("../../../container.js");
            req.pricingService = req.pricingService || container.pricingService;
            req.redisConnection = req.redisConnection || container.redisConnection;
        } catch {}
    }
    next();
});
adminRouter.use(requireAuth, requireAdmin);
adminRouter.post(
    "/wallet/credit",
    walletRateLimit({ max: 10, windowSec: 60, keyPrefix: "rate:admin" }),
    adminCredit
);
adminRouter.get("/wallet/:userId", getAdminWallet);
adminRouter.get("/reconciliation/latest", getLatestReconciliation);
adminRouter.patch("/pricing/:id", updatePricingRule);
adminRouter.post("/models/reload", reloadModels);

export default defaultBillingRouter;
