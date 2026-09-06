import { z } from "zod";
import { WalletError } from "#platform/billing/WalletService.js";

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

// ── Handlers ─────────────────────────────────────────────────────────────────

/**
 * POST /api/admin/wallet/credit
 * Manually credit or debit any user's wallet.
 * The admin's userId is stored in transaction metadata for auditing.
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
  const referenceId = `admin_${adminUserId}_${Date.now()}`;

  try {
    let transaction;

    if (type === "CREDIT") {
      transaction = await req.walletService.credit({
        userId,
        amount,
        referenceId,
        metadata: {
          adminUserId,
          reason,
          source: "admin_manual",
        },
      });
    } else {
      // DEBIT: hold then immediately commit (no TTL-based expiry needed for admin ops)
      await req.walletService.hold({
        userId,
        amount,
        referenceId,
        metadata: {
          adminUserId,
          reason,
          source: "admin_manual",
        },
      });
      transaction = await req.walletService.commitHoldIdempotent(referenceId);
    }

    const wallet = await req.walletService.getWalletOrThrow(userId);

    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      operation: "admin-credit",
      status: "success",
      adminUserId,
      targetUserId: userId,
      type,
      amount,
      durationMs: Date.now() - start,
    }));

    return res.json({ transaction, newBalance: wallet.balance });
  } catch (err) {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      operation: "admin-credit",
      status: "error",
      adminUserId,
      targetUserId: userId,
      error: err.message,
      code: err.code,
      durationMs: Date.now() - start,
    }));

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

    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      operation: "admin-get-wallet",
      status: "success",
      adminUserId,
      targetUserId: userId,
      durationMs: Date.now() - start,
    }));

    return res.json({ wallet, recentTransactions });
  } catch (err) {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      operation: "admin-get-wallet",
      status: "error",
      adminUserId,
      targetUserId: userId,
      error: err.message,
      durationMs: Date.now() - start,
    }));

    if (err instanceof WalletError) {
      return res.status(walletErrorToHttp(err)).json({ error: err.code, message: err.message });
    }
    return res.status(500).json({ error: "INTERNAL_ERROR", message: "Failed to fetch wallet." });
  }
}

/**
 * GET /api/admin/reconciliation/latest
 * Returns the result of the most recent nightly reconciliation run.
 * Data is written to Redis key 'reconcile:latest' by walletWorker.
 */
export async function getLatestReconciliation(req, res) {
  const start = Date.now();

  try {
    const raw = await req.redisConnection.get("reconcile:latest");

    if (!raw) {
      return res.json({
        status: "NOT_RUN",
        message: "Reconciliation job has not run yet. It runs daily at 03:00 UTC.",
        runAt: null,
        mismatchCount: 0,
        mismatches: [],
      });
    }

    const result = JSON.parse(raw);

    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      operation: "admin-get-reconciliation",
      status: "success",
      durationMs: Date.now() - start,
    }));

    return res.json(result);
  } catch (err) {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      operation: "admin-get-reconciliation",
      status: "error",
      error: err.message,
      durationMs: Date.now() - start,
    }));
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

    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      operation: "admin-update-pricing",
      status: "success",
      adminUserId,
      ruleId: id,
      updates: parsed.data,
      cacheInvalidated,
      durationMs: Date.now() - start,
    }));

    return res.json({ rule, cacheInvalidated });
  } catch (err) {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      operation: "admin-update-pricing",
      status: "error",
      adminUserId,
      ruleId: id,
      error: err.message,
      durationMs: Date.now() - start,
    }));
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

    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      operation: "admin-reload-models",
      status: "success",
      adminUserId,
      stats,
      durationMs: Date.now() - start,
    }));

    return res.status(200).json({
      status: "success",
      message: "Models registry reloaded successfully",
      stats,
    });
  } catch (err) {
    console.error(JSON.stringify({
      timestamp: new Date().toISOString(),
      operation: "admin-reload-models",
      status: "error",
      adminUserId,
      error: err.message,
      code: err.code || "REGISTRY_RELOAD_FAILED",
      durationMs: Date.now() - start,
    }));

    return res.status(400).json({
      status: "error",
      message: `Failed to reload models registry: ${err.message}`,
      code: err.code || "REGISTRY_RELOAD_FAILED",
    });
  }
}

