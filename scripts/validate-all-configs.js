#!/usr/bin/env node

import { initRegistry } from "../src/models/registry/modelRegistry.js";

console.log("==================================================");
console.log("  Models Management System — CI Config Validator  ");
console.log("==================================================");

try {
  const startTime = Date.now();
  const { models, providers, bindings, sharedParams } = initRegistry({ forceReload: true });
  const duration = Date.now() - startTime;

  console.log(`✓ 1. Structural Manifest Validation passed`);
  console.log(`✓ 2. Referential Integrity (Providers & Operations) passed`);
  console.log(`✓ 3. Canonical Parameter Vocabulary references passed`);
  console.log(`✓ 4. Composite Key Uniqueness passed`);
  console.log(`✓ 5. Retail Pricing & Binding Cost consistency passed`);
  console.log("--------------------------------------------------");
  console.log(`Successfully validated in ${duration}ms:`);
  console.log(`  - Models:     ${models.size}`);
  console.log(`  - Providers:  ${providers.size}`);
  console.log(`  - Bindings:   ${bindings.size}`);
  console.log(`  - Domains:    ${sharedParams.size}`);
  console.log("==================================================");
  process.exit(0);
} catch (err) {
  console.error(`\n❌ CI Validation Failed: ${err.message}`);
  process.exit(1);
}
