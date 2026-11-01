import { z } from "zod";
import { WalletError } from "#platform/billing/WalletService.js";
import { createLogger } from "../src/infrastructure/logging/index.js";

const walletLogger = createLogger("wallet_controller");

/**
 * Wallet Controller
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles user-facing wallet API endpoints:
 *   GET /api/wallet/balance       — current balance
 *   GET /api/wallet/transactions  — paginated transaction history
 *   GET /api/wallet/price         — credit cost for a model/operation/quality
 *
 * All endpoints require requireAuth middleware (req.user.id must be set).
 * All responses include structured logging with durationMs.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Validation Schemas ────────────────────────────────────────────────────────

const TransactionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  before: z.string().datetime({ offset: true }).optional(),
  beforeId: z.string().uuid().optional(),
});

const VALID_OPERATION_TYPES = ["IMAGE_GENERATION", "CHARACTER_SHEET"];
const VALID_QUALITY_TIERS = ["standard", "hd", "4k"];

const PriceQuerySchema = z.object({
  modelKey: z.string().min(1),
  operationType: z.enum(VALID_OPERATION_TYPES),
  qualityTier: z.enum(VALID_QUALITY_TIERS),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// ── Controllers ──────────────────────────────────────────────────────────────

/**
 * GET /api/wallet/balance
 * Returns the authenticated user's current credit balance.
 */
export async function getBalance(req, res) {
  const start = Date.now();
  const userId = req.user.id;

  try {
    const balance = await req.walletService.getBalance(userId);

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

    if (err instanceof WalletError) {
      return res.status(walletErrorToHttp(err)).json({ error: err.code, message: err.message });
    }
    return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to fetch balance." });
  }
}

/**
 * GET /api/wallet/transactions
 * Returns paginated transaction history for the authenticated user.
 * Supports cursor pagination via `before` (ISO 8601 string) and `beforeId` (UUID).
 */
export async function getTransactions(req, res) {
  const start = Date.now();
  const userId = req.user.id;

  const parsed = TransactionsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: "VALIDATION_ERROR",
      message: parsed.error.issues.map((i) => i.message).join("; "),
    });
  }

  const { limit, before, beforeId } = parsed.data;

  try {
    const result = await req.walletService.getTransactions(userId, limit, before, beforeId);

    walletLogger.info({
      operation: "get-transactions",
      status: "success",
      userId,
      limit,
      count: result.transactions.length,
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

    if (err instanceof WalletError) {
      return res.status(walletErrorToHttp(err)).json({ error: err.code, message: err.message });
    }
    return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to fetch transactions." });
  }
}

/**
 * GET /api/wallet/price
 * Returns the credit cost for a specific model / operation / quality combination.
 * Served from Redis cache (TTL 300s) or PostgreSQL on miss.
 */
export async function getPrice(req, res) {
  const start = Date.now();
  const userId = req.user.id;

  const parsed = PriceQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: "VALIDATION_ERROR",
      message: parsed.error.issues.map((i) => i.message).join("; "),
    });
  }

  const { modelKey, operationType, qualityTier } = parsed.data;

  try {
    const result = await req.pricingService.getPrice(modelKey, operationType, qualityTier);

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
}
