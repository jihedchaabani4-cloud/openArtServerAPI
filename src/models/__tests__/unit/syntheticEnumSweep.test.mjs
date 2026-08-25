import assert from "node:assert/strict";
import { getRegistry, loadRegistry } from "../../registry/loader.js";
import { calculateCostInternal } from "../../pricing/pricingFormulas.js";

loadRegistry();

console.log("Running Synthetic Enum Sweep across all Deployments...");

const { deployments } = getRegistry();

for (const dep of deployments.values()) {
  for (const [opName, opConfig] of Object.entries(dep.operations || {})) {
    const inputs = opConfig.inputs || {};
    const pricing = opConfig.pricing;
    if (!pricing) continue;

    // Collect all enum fields
    const enumFields = Object.entries(inputs)
      .filter(([_, def]) => def.type === "enum" && Array.isArray(def.values))
      .map(([k, def]) => ({ name: k, values: def.values }));

    // Generate Cartesian product of all enum values
    function cartesian(arr) {
      if (arr.length === 0) return [{}];
      const head = arr[0];
      const tail = cartesian(arr.slice(1));
      const res = [];
      for (const val of head.values) {
        for (const item of tail) {
          res.push({ ...item, [head.name]: val });
        }
      }
      return res;
    }

    const combos = cartesian(enumFields);
    for (const combo of combos) {
      const amountStr = calculateCostInternal(combo, pricing);
      assert.ok(typeof amountStr === "string", "Returns string amount");
      const num = Number(amountStr);
      assert.ok(!Number.isNaN(num), `Amount is not NaN for combo ${JSON.stringify(combo)}`);
      assert.ok(Number.isFinite(num), `Amount is finite for combo ${JSON.stringify(combo)}`);
    }
  }
}

console.log("✓ Synthetic enum sweep passed — 0 NaN results!");
