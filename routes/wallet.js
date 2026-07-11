import express from "express";
import { requireAuth } from "../src/middleware/auth.js";
import { walletRateLimit } from "../src/middleware/walletRateLimit.js";
import { walletService } from "../src/container.js";
import { pricingService } from "../src/container.js";
import {
  getBalance,
  getTransactions,
  getPrice,
} from "../controllers/walletController.js";

const router = express.Router();

// Inject services into req so controllers don't import container directly
router.use((req, _res, next) => {
  req.walletService = walletService;
  req.pricingService = pricingService;
  next();
});

// All wallet routes require authentication + per-user rate limiting
router.use(requireAuth);
router.use(walletRateLimit({ max: 30, windowSec: 60 }));

// GET /api/wallet/balance
router.get("/balance", getBalance);

// GET /api/wallet/transactions?limit=20&before=<iso>&beforeId=<uuid>
router.get("/transactions", getTransactions);

// GET /api/wallet/price?modelKey=kling-v1&operationType=VIDEO_GENERATION&qualityTier=standard
router.get("/price", getPrice);

export default router;
