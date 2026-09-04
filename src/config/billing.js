/**
 * Central Billing Configuration
 * Single source of truth for credit valuation across the platform.
 */

export const DEFAULT_CREDIT_TO_USD_RATE = 0.15;

export const billingConfig = {
  creditToUsdRate: DEFAULT_CREDIT_TO_USD_RATE,
};

export function getCreditToUsdRate() {
  const envVal = process.env.CREDIT_TO_USD_RATE;
  if (envVal !== undefined && envVal !== "" && !Number.isNaN(Number(envVal))) {
    return Number(envVal);
  }
  return billingConfig.creditToUsdRate || DEFAULT_CREDIT_TO_USD_RATE;
}
