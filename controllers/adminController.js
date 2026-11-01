import { z } from "zod";
import { WalletError } from "#platform/billing/WalletService.js";
import { createLogger } from "../src/infrastructure/logging/index.js";

const adminLogger = createLogger("admin_controller");

/**
 * Admin Controller
 * ─────────────────────────────────────────────────────────────────────────────
 * Handles admin-only wallet management endpoints:
 *   POST   /api/admin/wallet/credit        — manual credit or debit any user
 *   GET    /api/admin/wallet/:userId       — view any user's wallet + recent txns
 *   GET    /api/admin/reconciliation/latest — latest reconciliation run result
 *   PATCH  /api/admin/pricing/:id          — update pricing rule (+ cache invalidation)
 *
 * All endpoints require requireAuth + requireAdmin middleware.
 * Every handler emits structured JSON logs with durationMs.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Validation Schemas ────────────────────────────────────────────────────────

const AdminCreditSchema = z.object({
  userId: z.string().uuid({ message: "userId must be a valid UUID" }),
  amount: z.number().positive({ message: "amount must be a positive number" }).int({ message: "amount must be an integer" }),
  type: z.enum(["CREDIT", "DEBIT"]),
  reason: z.string().min(1).max(500),
});

const UpdatePricingSchema = z.object({
  creditCost: z.number().positive().optional(),
  isActive: z.boolean().optional(),
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
 * POST /api/admin/wallet/credit
 * Manually credit or debit a user's wallet. Used for refunds, goodwill, and manual adjustments.
 */
export async function adminCredit(req, res) {
  const start = Date.now();
  const adminUserId = req.adminUser?.id || req.user?.id;

  const parsed = AdminCreditSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "VALIDATION_ERROR",
      message: parsed.error.issues.map((i) => i.message).join("; "),
    });
  }

  const { userId, amount, type, reason } = parsed.data;

  try {
    const referenceId = `admin_${type.toLowerCase()}_${Date.now()}_${userId.slice(0, 8)}`;
    const metadata = {
      adminUserId,
      reason,
      adjustedAt: new Date().toISOString(),
      type,
    };

    let transaction;
    if (type === "CREDIT") {
      transaction = await req.walletService.credit({
        userId,
        amount,
        referenceId,
        metadata,
      });
    } else {
      transaction = await req.walletService.debit({
        userId,
        amount,
        referenceId,
        metadata,
      });
    }

    const wallet = await req.walletService.getWalletOrThrow(userId);

    adminLogger.info({
      operation: "admin-credit",
      status: "success",
      adminUserId,
      targetUserId: userId,
      type,
      amount,
      durationMs: Date.now() - start,
    }, "Admin credit operation succeeded");

    return res.json({ transaction, newBalance: wallet.balance });
  } catch (err) {
    adminLogger.error({
      operation: "admin-credit",
      status: "error",
      adminUserId,
      targetUserId: userId,
      error: err.message,
      code: err.code,
      durationMs: Date.now() - start,
    }, "Admin credit operation failed");

    if (err instanceof WalletError) {
      return res.status(walletErrorToHttp(err)).json({ error: err.code, message: err.message });
    }
    return res.status(500).json({ error: "INTERNAL_ERROR", message: "Admin credit operation failed." });
  }
}

/**
 * GET /api/admin/wallet/:userId
 * View any user's wallet + 10 most recent transactions. Used for support investigation.
 */
export async function getAdminWallet(req, res) {
  const start = Date.now();
  const adminUserId = req.adminUser?.id || req.user?.id;
  const { userId } = req.params;

  if (!userId?.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
    return res.status(400).json({ error: "VALIDATION_ERROR", message: "userId must be a valid UUID" });
  }

  try {
    const wallet = await req.walletService.getWalletOrThrow(userId);
    const { transactions: recentTransactions } = await req.walletService.getTransactions(userId, 10, null, null);

    adminLogger.info({
      operation: "admin-get-wallet",
      status: "success",
      adminUserId,
      targetUserId: userId,
      durationMs: Date.now() - start,
    }, "Admin fetched wallet");

    return res.json({ wallet, recentTransactions });
  } catch (err) {
    adminLogger.error({
      operation: "admin-get-wallet",
      status: "error",
      adminUserId,
      targetUserId: userId,
      error: err.message,
      durationMs: Date.now() - start,
    }, "Admin failed to fetch wallet");

    if (err instanceof WalletError) {
      return res.status(walletErrorToHttp(err)).json({ error: err.code, message: err.message });
    }
    return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to fetch wallet." });
  }
}

/**
 * GET /api/admin/reconciliation/latest
 * Returns the latest daily reconciliation result from Redis cache.
 * Falls back to DB scan if Redis key is missing.
 */
export async function getLatestReconciliation(req, res) {
  const start = Date.now();

  try {
    const redis = req.redisConnection;
    const raw = await redis.get("reconciliation:latest");

    if (!raw) {
      return res.json({
        cached: false,
        status: "NO_RUN_RECORDED",
        message: "No reconciliation run recorded in cache.",
        runAt: null,
        mismatchCount: 0,
        mismatches: [],
      });
    }

    const result = JSON.parse(raw);

    adminLogger.info({
      operation: "admin-get-reconciliation",
      status: "success",
      durationMs: Date.now() - start,
    }, "Admin fetched reconciliation result");

    return res.json(result);
  } catch (err) {
    adminLogger.error({
      operation: "admin-get-reconciliation",
      status: "error",
      error: err.message,
      durationMs: Date.now() - start,
    }, "Admin failed to fetch reconciliation result");
    return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to fetch reconciliation result." });
  }
}

/**
 * PATCH /api/admin/pricing/:id
 * Update a pricing rule's creditCost and/or isActive flag.
 * Automatically invalidates the Redis cache for the affected rule.
 */
export async function updatePricingRule(req, res) {
  const start = Date.now();
  const adminUserId = req.adminUser?.id || req.user?.id;
  const { id } = req.params;

  if (!id?.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
    return res.status(400).json({ error: "VALIDATION_ERROR", message: "id must be a valid UUID" });
  }

  const parsed = UpdatePricingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "VALIDATION_ERROR",
      message: parsed.error.issues.map((i) => i.message).join("; "),
    });
  }

  if (Object.keys(parsed.data).length === 0) {
    return res.status(400).json({
      error: "VALIDATION_ERROR",
      message: "At least one of creditCost or isActive must be provided.",
    });
  }

  try {
    const { rule, cacheInvalidated } = await req.pricingService.updateRule(id, parsed.data);

    adminLogger.info({
      operation: "admin-update-pricing",
      status: "success",
      adminUserId,
      ruleId: id,
      updates: parsed.data,
      cacheInvalidated,
      durationMs: Date.now() - start,
    }, "Admin updated pricing rule");

    return res.json({ rule, cacheInvalidated });
  } catch (err) {
    adminLogger.error({
      operation: "admin-update-pricing",
      status: "error",
      adminUserId,
      ruleId: id,
      error: err.message,
      durationMs: Date.now() - start,
    }, "Admin failed to update pricing rule");
    return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to update pricing rule." });
  }
}

/**
 * POST /api/admin/models/reload
 * Safe hot-reload of the models registry.
 * Re-scans manifests and fail-fast validates. If any failure occurs,
 * the active in-memory registry is kept completely intact and untouched.
 */
export async function reloadModels(req, res) {
  const start = Date.now();
  const adminUserId = req.adminUser?.id || req.user?.id;

  try {
    const { reloadRegistry, getRegistryStats } = await import("../src/models/index.js");
    reloadRegistry();
    const stats = getRegistryStats();

    adminLogger.info({
      operation: "admin-reload-models",
      status: "success",
      adminUserId,
      stats,
      durationMs: Date.now() - start,
    }, "Admin reloaded models registry");

    return res.status(200).json({
      status: "success",
      message: "Models registry reloaded successfully",
      stats,
    });
  } catch (err) {
    adminLogger.error({
      operation: "admin-reload-models",
      status: "error",
      adminUserId,
      error: err.message,
      code: err.code || "REGISTRY_RELOAD_FAILED",
      durationMs: Date.now() - start,
    }, "Admin failed to reload models registry");

    return res.status(400).json({
      status: "error",
      message: `Failed to reload models registry: ${err.message}`,
      code: err.code || "REGISTRY_RELOAD_FAILED",
    });
  }
}
