import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationPath = path.resolve(__dirname, "../../migrations/008_create_folders_and_extend_workflow.sql");

describe("Database Migration 008 Schema Verification (Task F-T2)", () => {
  it("migration file 008_create_folders_and_extend_workflow.sql exists", () => {
    assert.equal(
      fs.existsSync(migrationPath),
      true,
      `Migration file does not exist at ${migrationPath}`
    );
  });

  it("creates folders table with required columns and constraints", () => {
    const content = fs.readFileSync(migrationPath, "utf-8");
    assert.match(content, /create table if not exists folders/i);
    assert.match(content, /\bid\s+uuid\b/i);
    assert.match(content, /\bproject_id\s+uuid\b/i);
    assert.match(content, /\buser_id\s+uuid\b/i);
    assert.match(content, /\bparent_id\s+uuid\b/i);
    assert.match(content, /\bname\s+text\b/i);
    assert.match(content, /\bposition\s+integer\b/i);
    assert.match(content, /\bcreated_at\s+timestamptz\b/i);
    assert.match(content, /\bupdated_at\s+timestamptz\b/i);

    // Composite unique constraint
    assert.match(content, /constraint\s+folders_project_folder_uq\s+unique\s*\(\s*id\s*,\s*project_id\s*\)/i);

    // Self-referencing FK with NO ACTION (default in PG, must NOT specify RESTRICT)
    assert.match(content, /foreign\s+key\s*\(\s*parent_id\s*,\s*project_id\s*\)\s*references\s+folders\s*\(\s*id\s*,\s*project_id\s*\)/i);
    assert.doesNotMatch(content, /references\s+folders\s*\(\s*id\s*,\s*project_id\s*\)\s+on\s+delete\s+restrict/i);

    // Sibling unique index with COALESCE for root folders
    assert.match(content, /create\s+unique\s+index\s+if\s+not\s+exists\s+folders_sibling_name_uq/i);
    assert.match(content, /00000000-0000-0000-0000-000000000000/i);
    assert.match(content, /lower\s*\(\s*name\s*\)/i);
  });

  it("extends workflow table with folder_id, composite FK, and check constraint (Path A)", () => {
    const content = fs.readFileSync(migrationPath, "utf-8");
    assert.match(content, /alter\s+table\s+workflow\s+add\s+column\s+if\s+not\s+exists\s+folder_id\s+uuid/i);
    assert.match(content, /workflow_folder_same_project_fk/i);
    assert.match(content, /foreign\s+key\s*\(\s*folder_id\s*,\s*project_id\s*\)\s*references\s+folders\s*\(\s*id\s*,\s*project_id\s*\)/i);
    assert.match(content, /workflow_folder_needs_project_ck/i);
    assert.match(content, /check\s*\(\s*folder_id\s+is\s+null\s+or\s+project_id\s+is\s+not\s+null\s*\)/i);
    assert.match(content, /workflow_project_folder_idx/i);
  });

  it("extends workflow table with nullable user_id and includes idempotent backfill from projects", () => {
    const content = fs.readFileSync(migrationPath, "utf-8");
    assert.match(content, /alter\s+table\s+workflow\s+add\s+column\s+if\s+not\s+exists\s+user_id\s+uuid/i);
    assert.match(content, /update\s+workflow\s+.*set\s+user_id\s*=\s*.*user_id.*from\s+projects/is);
    assert.match(content, /where\s+.*user_id\s+is\s+null/is);
  });

  it("is strictly additive in active statements (no drops or renames outside comments)", () => {
    const content = fs.readFileSync(migrationPath, "utf-8");
    // Strip comments to verify active SQL statements
    const activeSql = content
      .replace(/--.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    assert.doesNotMatch(activeSql, /\bdrop\s+table\b/i);
    assert.doesNotMatch(activeSql, /\bdrop\s+column\b/i);
    assert.doesNotMatch(activeSql, /\brename\b/i);
    assert.doesNotMatch(activeSql, /\balter\s+column\b/i);
  });

  it("contains clear rollback instructions in comments", () => {
    const content = fs.readFileSync(migrationPath, "utf-8");
    assert.match(content, /rollback/i);
    assert.match(content, /DROP CONSTRAINT/i);
    assert.match(content, /DROP TABLE/i);
  });
});
