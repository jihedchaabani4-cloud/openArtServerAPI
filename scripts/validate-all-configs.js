#!/usr/bin/env node

import { loadRegistry } from "../src/models/registry/loader.js";

console.log("==================================================");
console.log("  Models Management System — CI Config Validator  ");
console.log("==================================================");

try {
  const startTime = Date.now();
  const { families, providers, deployments, collections, parameters, pricingRules } = loadRegistry({ strict: true });
  const duration = Date.now() - startTime;

  console.log(`✓ 1. Structural Validation passed`);
  console.log(`✓ 2. Referential Integrity passed`);
  console.log(`✓ 3. Single Servable Rule passed`);
  console.log(`✓ 4. Canonical Parameter Vocabulary references passed`);
  console.log(`✓ 5. Decoupled Pricing Rules & Modifiers consistency passed`);
  console.log(`✓ 6. Pricing↔Inputs Consistency passed`);
  console.log(`✓ 7. Case-sensitive enum match passed`);
  console.log(`✓ 8. Output Contract check passed`);
  console.log(`✓ 9. Passthrough/Canonical Collision check passed`);
  console.log(`✓ 10. Schema Version validity passed`);
  console.log("--------------------------------------------------");
  console.log(`Successfully validated in ${duration}ms:`);
  console.log(`  - Parameters:  ${parameters.size}`);
  console.log(`  - Families:    ${families.size}`);
  console.log(`  - Providers:   ${providers.size}`);
  console.log(`  - Deployments: ${deployments.size}`);
  console.log(`  - PricingRules:${pricingRules.size}`);
  console.log(`  - Collections: ${collections.size}`);
  console.log("==================================================");
  process.exit(0);
} catch (err) {
  console.error("❌ CI Configuration Validation Failed:");
  console.error(err.message || err);
  if (err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
}
