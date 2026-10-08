import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const migrationPath = path.resolve(__dirname, "../../migrations/009_create_workflow_media.sql");

function activeSql(sql) {
  return sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("Database Migration 009 Workflow Media Relation", () => {
  it("creates workflow_media with canonical columns and constraints", () => {
    assert.equal(fs.existsSync(migrationPath), true, `Missing migration at ${migrationPath}`);
    const sql = fs.readFileSync(migrationPath, "utf-8");

    assert.match(sql, /create\s+table\s+if\s+not\s+exists\s+(?:public\.)?workflow_media/i);
    assert.match(sql, /\bworkflow_id\s+uuid\s+not\s+null/i);
    assert.match(sql, /\bmedia_id\s+uuid\s+not\s+null/i);
    assert.match(sql, /\brole\s+text\s+not\s+null/i);
    assert.match(sql, /\bcreated_at\s+timestamptz\s+not\s+null\s+default\s+now\(\)/i);
    assert.match(sql, /workflow_media_pkey/i);
    assert.match(sql, /foreign\s+key\s*\(\s*workflow_id\s*\)\s+references\s+(?:public\.)?workflow\s*\(\s*id\s*\)/i);
    assert.match(sql, /foreign\s+key\s*\(\s*media_id\s*\)\s+references\s+(?:public\.)?media\s*\(\s*id\s*\)/i);
  });

  it("defines the approved role vocabulary and lookup indexes", () => {
    const sql = fs.readFileSync(migrationPath, "utf-8");

    for (const role of ["output", "original", "sheet", "detail", "reference", "avatar", "turnaround"]) {
      assert.match(sql, new RegExp(`'${role}'`, "i"), `Missing role ${role}`);
    }

    assert.match(sql, /workflow_media_workflow_id_idx/i);
    assert.match(sql, /workflow_media_media_id_idx/i);
    assert.match(sql, /workflow_media_role_idx/i);
  });

  it("backfills relation rows from legacy media.workflow_id and media.step_id", () => {
    const sql = fs.readFileSync(migrationPath, "utf-8");

    assert.match(sql, /insert\s+into\s+(?:public\.)?workflow_media/i);
    assert.match(sql, /from\s+(?:public\.)?media\s+m/i);
    assert.match(sql, /join\s+(?:public\.)?workflow\s+w\s+on\s+w\.id\s*=\s*m\.workflow_id/i);
    assert.match(sql, /m\.step_id\s+in\s*\(\s*'image_generation'\s*,\s*'video_generation'\s*\)/i);
    assert.match(sql, /m\.step_id\s*=\s*'character_detail'/i);
    assert.match(sql, /on\s+conflict\s+do\s+nothing/i);
  });

  it("is additive in active statements and documents rollback manually", () => {
    const sql = fs.readFileSync(migrationPath, "utf-8");
    const active = activeSql(sql);

    assert.doesNotMatch(active, /\bdrop\s+table\b/i);
    assert.doesNotMatch(active, /\bdrop\s+column\b/i);
    assert.doesNotMatch(active, /\brename\b/i);
    assert.doesNotMatch(active, /\balter\s+column\b/i);
    assert.match(sql, /rollback/i);
    assert.match(sql, /drop\s+table\s+if\s+exists\s+workflow_media/i);
  });
});
