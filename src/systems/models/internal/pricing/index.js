/**
 * System 2: Models Management — Pricing Calculation Subsystem (Internal)
 *
 * Rule 10: Model pricing calculation strictly decoupled from Billing's wallet ledger.
 * This subsystem computes credit and wholesale costs from manifests and rules,
 * without touching user account balances or reservations.
 */

import {
  calculateRetailCredits,
  calculateWholesaleCostUsd,
  calculateMargin,
} from "./pricingEngine.js";
import {
  calculateCost,
  getCatalog,
} from "../catalogQueries.js";
import {
  estimatePrice,
} from "../index.js";
import {
  PricingService,
} from "./PricingService.js";

export {
  calculateRetailCredits,
  calculateWholesaleCostUsd,
  calculateMargin,
  calculateCost,
  getCatalog,
  estimatePrice,
  PricingService,
};

export default {
  calculateRetailCredits,
  calculateWholesaleCostUsd,
  calculateMargin,
  calculateCost,
  getCatalog,
  estimatePrice,
  PricingService,
};
