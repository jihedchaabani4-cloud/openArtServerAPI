import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schemasDir = path.resolve(__dirname, "../schemas");

function loadSchema(relPath) {
  const fullPath = path.join(schemasDir, relPath);
  return JSON.parse(fs.readFileSync(fullPath, "utf8"));
}

export const SCHEMA_VERSIONS = Object.freeze({
  "1.0": {
    family: loadSchema("v1/family.schema.json"),
    provider: loadSchema("v1/provider.schema.json"),
    deployment: loadSchema("v1/deployment.schema.json"),
    collection: loadSchema("v1/collection.schema.json"),
    parameter: loadSchema("v1/parameter.schema.json"),
    pricing: loadSchema("v1/pricing.schema.json"),
  },
});

export function getSchemaForVersion(version = "1.0", entityType) {
  const versionSchemas = SCHEMA_VERSIONS[version];
  if (!versionSchemas) {
    throw new Error(`Unsupported schemaVersion: "${version}"`);
  }
  const schema = versionSchemas[entityType];
  if (!schema) {
    throw new Error(`No schema found for entity "${entityType}" in version "${version}"`);
  }
  return schema;
}
