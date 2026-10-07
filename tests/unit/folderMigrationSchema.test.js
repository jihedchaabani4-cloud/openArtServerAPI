import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationPath = path.resolve(__dirname, "../../migrations/008_create_folders_and_extend_workflow.sql");
const schemaPath = path.resolve(__dirname, "../../database_schema.sql");

describe("Database Migration 008 Schema Verification (Task F-T2)", () => {
  it("migration file 008_create_folders_and_extend_workflow.sql and database_schema.sql exist", () => {
    assert.equal(
      fs.existsSync(migrationPath),
      true,
      `Migration file does not exist at ${migrationPath}`
    );
    assert.equal(
      fs.existsSync(schemaPath),
      true,
      `database_schema.sql does not exist at ${schemaPath}`
    );
  });

  it("references only real tables that exist in database_schema.sql (singular 'project', not 'projects')", () => {
    const migrationContent = fs.readFileSync(migrationPath, "utf-8");
    const schemaContent = fs.readFileSync(schemaPath, "utf-8");

    // Extract table names defined in database_schema.sql
    const tableMatches = [...schemaContent.matchAll(/CREATE\s+TABLE\s+(?:public\.)?([a-zA-Z0-9_]+)\s*\(/gi)];
    const existingTables = new Set(tableMatches.map((m) => m[1].toLowerCase()));

    assert(existingTables.has("project"), "database_schema.sql must define table 'project'");
    assert(!existingTables.has("projects"), "database_schema.sql must NOT define plural 'projects'");

    // Migration must NOT reference 'projects' in FK or queries
    assert.doesNotMatch(
      migrationContent,
      /references\s+(?:public\.)?projects\b/i,
      "Migration 008 references 'projects' instead of real table 'project'"
    );
    assert.doesNotMatch(
      migrationContent,
      /from\s+(?:public\.)?projects\b/i,
      "Migration 008 backfill references 'projects' instead of real table 'project'"
    );

    // Migration must reference singular 'project'
    assert.match(
      migrationContent,
      /references\s+(?:public\.)?project\s*\(\s*id\s*\)/i,
      "Migration 008 must reference real table 'project(id)'"
    );
    assert.match(
      migrationContent,
      /from\s+(?:public\.)?project\b/i,
      "Migration 008 backfill must reference real table 'project'"
    );
  });

  it("references only real columns that exist in database_schema.sql on workflow ('create_time', not 'created_at')", () => {
    const migrationContent = fs.readFileSync(migrationPath, "utf-8");
    const schemaContent = fs.readFileSync(schemaPath, "utf-8");

    // Extract workflow table definition from database_schema.sql
    const wfMatch = schemaContent.match(/CREATE\s+TABLE\s+public\.workflow\s*\(([\s\S]*?)\n\);/i);
    assert(wfMatch, "Could not find CREATE TABLE public.workflow in database_schema.sql");
    const wfBody = wfMatch[1];

    assert.match(wfBody, /\bcreate_time\s+timestamp/i, "workflow table has 'create_time' column");
    assert.doesNotMatch(wfBody, /\bcreated_at\b/i, "workflow table does NOT have 'created_at' column");

    // Migration must NOT reference workflow(..., created_at)
    assert.doesNotMatch(
      migrationContent,
      /workflow\s*\([^)]*created_at[^)]*\)/i,
      "Migration 008 references 'created_at' on workflow, which does not exist in database_schema.sql"
    );

    // Migration must reference real column create_time in workflow index
    assert.match(
      migrationContent,
      /workflow\s*\([^)]*create_time[^)]*\)/i,
      "Migration 008 must index workflow with real column 'create_time'"
    );
  });

  it("removes redundant needs_project check since workflow.project_id is already NOT NULL", () => {
    const migrationContent = fs.readFileSync(migrationPath, "utf-8");
    const schemaContent = fs.readFileSync(schemaPath, "utf-8");

    // In database_schema.sql, workflow.project_id is NOT NULL
    assert.match(
      schemaContent,
      /project_id\s+uuid\s+NOT\s+NULL/i,
      "workflow.project_id is defined as NOT NULL in database_schema.sql"
    );

    // Therefore redundant needs_project check must NOT be present
    assert.doesNotMatch(
      migrationContent,
      /workflow_folder_needs_project_ck/i,
      "Redundant workflow_folder_needs_project_ck constraint should be removed"
    );
  });

  it("creates folders table with position (as required by plan) and self-referencing FK with NO ACTION", () => {
    const migrationContent = fs.readFileSync(migrationPath, "utf-8");
    assert.match(migrationContent, /create table if not exists folders/i);
    assert.match(migrationContent, /\bposition\s+integer\b/i, "folders table must have position column per plan");
    assert.match(
      migrationContent,
      /foreign\s+key\s*\(\s*parent_id\s*,\s*project_id\s*\)\s*references\s+folders\s*\(\s*id\s*,\s*project_id\s*\)/i
    );
    assert.doesNotMatch(
      migrationContent,
      /references\s+folders\s*\(\s*id\s*,\s*project_id\s*\)\s+on\s+delete\s+restrict/i
    );
    assert.match(migrationContent, /folders_sibling_name_uq/i);
  });

  it("enables Row Level Security (RLS) on public.folders with folders_owner policy matching repo conventions", () => {
    const migrationContent = fs.readFileSync(migrationPath, "utf-8");
    assert.match(
      migrationContent,
      /ALTER\s+TABLE\s+(?:public\.)?folders\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/i,
      "Migration 008 must enable RLS on folders table"
    );
    assert.match(
      migrationContent,
      /CREATE\s+POLICY\s+"folders_owner"\s+ON\s+(?:public\.)?folders/i,
      "Migration 008 must create folders_owner policy"
    );
    assert.match(
      migrationContent,
      /auth\.uid\(\)/i,
      "folders_owner policy must enforce auth.uid()"
    );
  });

  it("is strictly additive in active statements (no drops or renames outside comments)", () => {
    const migrationContent = fs.readFileSync(migrationPath, "utf-8");
    const activeSql = migrationContent
      .replace(/--.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    assert.doesNotMatch(activeSql, /\bdrop\s+table\b/i);
    assert.doesNotMatch(activeSql, /\bdrop\s+column\b/i);
    assert.doesNotMatch(activeSql, /\brename\b/i);
    assert.doesNotMatch(activeSql, /\balter\s+column\b/i);
  });

  it("contains clear rollback instructions in comments", () => {
    const migrationContent = fs.readFileSync(migrationPath, "utf-8");
    assert.match(migrationContent, /rollback/i);
    assert.match(migrationContent, /DROP CONSTRAINT/i);
    assert.match(migrationContent, /DROP TABLE/i);
  });
});
