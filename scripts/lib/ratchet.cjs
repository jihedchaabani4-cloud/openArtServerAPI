'use strict';
// Shared ratchet helper (identical copy lives in my-app/scripts/lib).
// A "violation" is { key: '<RULE>|<file>', detail: 'file:line  text' }.
// The baseline stores how many violations each key is allowed to have. It can only shrink.
const fs = require('fs');

function countByKey(violations) {
  const m = {};
  for (const v of violations) m[v.key] = (m[v.key] || 0) + 1;
  return m;
}

function loadBaseline(file) {
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeBaseline(file, counts) {
  const sorted = {};
  for (const k of Object.keys(counts).sort()) sorted[k] = counts[k];
  fs.writeFileSync(file, JSON.stringify(sorted, null, 2) + '\n');
}

// Returns keys whose current count is above the baseline (new violations).
function compare(violations, baseline) {
  const counts = countByKey(violations);
  const fresh = [];
  for (const [key, n] of Object.entries(counts)) {
    const allowed = baseline[key] || 0;
    if (n > allowed) {
      fresh.push({ key, allowed, found: n, items: violations.filter((v) => v.key === key) });
    }
  }
  return { counts, fresh };
}

// New baseline = min(old, now) per key. Never increases. Zero entries are dropped.
function shrink(counts, baseline) {
  const out = {};
  for (const [k, allowed] of Object.entries(baseline)) {
    const n = Math.min(allowed, counts[k] || 0);
    if (n > 0) out[k] = n;
  }
  return out;
}

module.exports = { countByKey, loadBaseline, writeBaseline, compare, shrink };
