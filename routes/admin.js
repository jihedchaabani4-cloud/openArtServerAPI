import express from "express";
import { requireAuth } from "../src/middleware/auth.js";
import { requireAdmin } from "../src/middleware/requireAdmin.js";
import { walletRateLimit } from "../src/middleware/walletRateLimit.js";
import { walletService, pricingService } from "../src/container.js";
import { redisConnection } from "../src/queue/redis.js";
import {
  adminCredit,
  getAdminWallet,
  getLatestReconciliation,
  updatePricingRule,
  reloadModels,
} from "../controllers/adminController.js";

const router = express.Router();

// Inject services into req so controllers stay decoupled from the container
router.use((req, _res, next) => {
  req.walletService = walletService;
  req.pricingService = pricingService;
  req.redisConnection = redisConnection;
  next();
});

// All admin routes require authentication AND admin role verification
router.use(requireAuth, requireAdmin);

// POST /api/admin/wallet/credit — manual credit or debit (rate-limited to 10/min per admin)
router.post(
  "/wallet/credit",
  walletRateLimit({ max: 10, windowSec: 60, keyPrefix: "rate:admin" }),
  adminCredit
);

// GET /api/admin/wallet/:userId — view any user's wallet + recent transactions
router.get("/wallet/:userId", getAdminWallet);

// GET /api/admin/reconciliation/latest — latest reconciliation job result
router.get("/reconciliation/latest", getLatestReconciliation);

// PATCH /api/admin/pricing/:id — update pricing rule + invalidate cache
// (rate-limited: pricing changes should be deliberate)
router.patch(
  "/pricing/:id",
  walletRateLimit({ max: 10, windowSec: 60, keyPrefix: "rate:admin" }),
  updatePricingRule
);

// POST /api/admin/models/reload — hot reload models registry safely
router.post("/models/reload", reloadModels);

export default router;
