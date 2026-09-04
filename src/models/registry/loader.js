import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateStructural, validateAllConsistencyChecks } from "./validator.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const modelsRoot = path.resolve(__dirname, "..");
const projectRoot = path.resolve(modelsRoot, "..");

const families = new Map();
const providers = new Map();
const deployments = new Map();
const collections = new Map();
const parameters = new Map();
const pricingRules = new Map();
let isLoaded = false;

function readJsonFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isFile() && entry.name.endsWith(".json")) {
      const raw = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      results.push({ filename: entry.name, fullPath, data: raw });
    }
  }
  return results;
}

function readProviderFiles(providersDir) {
  if (!fs.existsSync(providersDir)) return [];
  const entries = fs.readdirSync(providersDir, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const providerJsonPath = path.join(providersDir, entry.name, "provider.json");
      if (fs.existsSync(providerJsonPath)) {
        const raw = JSON.parse(fs.readFileSync(providerJsonPath, "utf8"));
        results.push({ filename: entry.name, fullPath: providerJsonPath, data: raw });
      }
    }
  }
  return results;
}

export function loadRegistry({ strict = true } = {}) {
  families.clear();
  providers.clear();
  deployments.clear();
  collections.clear();
  parameters.clear();
  pricingRules.clear();

  // 0. Shared Canonical Parameters
  const sharedDir = path.join(modelsRoot, "shared");
  for (const { data } of readJsonFiles(sharedDir)) {
    validateStructural(data, "parameter", "1.0");
    parameters.set(data.id, Object.freeze(data));
  }

  // 1. Families
  const familiesDir = path.join(modelsRoot, "families");
  for (const { data } of readJsonFiles(familiesDir)) {
    validateStructural(data, "family", "1.0");
    families.set(data.id, Object.freeze(data));
  }

  // 2. Providers
  const providersDir = path.join(projectRoot, "providers");
  for (const { data } of readProviderFiles(providersDir)) {
    validateStructural(data, "provider", "1.0");
    providers.set(data.id, Object.freeze(data));
  }

  // 3. Deployments
  const deploymentsDir = path.join(modelsRoot, "deployments");
  for (const { data } of readJsonFiles(deploymentsDir)) {
    const version = data.schemaVersion || "1.0";
    validateStructural(data, "deployment", version);
    deployments.set(data.id, Object.freeze(data));
  }

  // 4. Collections
  const collectionsDir = path.join(modelsRoot, "collections");
  for (const { data } of readJsonFiles(collectionsDir)) {
    validateStructural(data, "collection", "1.0");
    collections.set(data.id, Object.freeze(data));
  }

  // 5. Pricing Rules
  const pricingRulesDir = path.join(modelsRoot, "pricing", "rules");
  for (const { data } of readJsonFiles(pricingRulesDir)) {
    validateStructural(data, "pricing", "1.0");
    pricingRules.set(`${data.model}.${data.operation}`, Object.freeze(data));
  }

  // 6. Cross-file consistency validation
  if (strict && (families.size > 0 || deployments.size > 0)) {
    validateAllConsistencyChecks({ families, providers, deployments, collections, parameters, pricingRules });
  }

  isLoaded = true;
  return { families, providers, deployments, collections, parameters, pricingRules };
}

export function getRegistry() {
  if (!isLoaded) {
    loadRegistry();
  }
  return { families, providers, deployments, collections, parameters, pricingRules };
}

export function getParameters() {
  return getRegistry().parameters;
}

export function getPricingRules() {
  return getRegistry().pricingRules;
}

export function resetRegistry() {
  families.clear();
  providers.clear();
  deployments.clear();
  collections.clear();
  parameters.clear();
  pricingRules.clear();
  isLoaded = false;
}
