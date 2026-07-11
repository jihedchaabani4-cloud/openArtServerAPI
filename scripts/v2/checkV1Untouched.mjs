import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(__dirname, "../..");

/** @type {string[]} */
const forbiddenV2ImportsInV1 = [
  "src/workflows/workflowRunner.js",
  "src/treatments/treatmentRegistry.js",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function checkV1RoutesIntact() {
  const routes = fs.readFileSync(path.join(apiRoot, "src/api/routes.js"), "utf8");
  assert(routes.includes("workflowsRouter"), "V1 /workflows router must remain mounted.");
  assert(routes.includes("/v2/workflows"), "V2 router must be mounted separately.");
}

function checkNoV2ImportsInV1Core() {
  for (const relativePath of forbiddenV2ImportsInV1) {
    const fullPath = path.join(apiRoot, relativePath);
    if (!fs.existsSync(fullPath)) continue;
    const content = fs.readFileSync(fullPath, "utf8");
    assert(!content.includes("/v2/"), `${relativePath} must not import V2 modules.`);
  }
}

function checkV2TreeIsolated() {
  const v2Root = path.join(apiRoot, "src/v2");
  assert(fs.existsSync(v2Root), "V2 source tree must exist under src/v2.");
}

export function runV1UntouchedCheck() {
  checkV1RoutesIntact();
  checkNoV2ImportsInV1Core();
  checkV2TreeIsolated();
  console.log("[v2:checkV1Untouched] PASS");
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  runV1UntouchedCheck();
}
