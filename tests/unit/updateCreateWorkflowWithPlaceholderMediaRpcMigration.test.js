import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const migrationPath = path.resolve(
  __dirname,
  "../../../supabase/migrations/20261018162500_update_create_workflow_with_placeholder_media_rpc.sql"
);

function activeSql(sql) {
  return sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("Ticket 03: update_create_workflow_with_placeholder_media_rpc migration", () => {
  it("migration file exists and updates RPC without media.workflow_id column", () => {
    assert.equal(fs.existsSync(migrationPath), true, `Missing migration at ${migrationPath}`);
    const sql = fs.readFileSync(migrationPath, "utf-8");
    const active = activeSql(sql);

    // 1. Replaces function create_workflow_with_placeholder_media
    assert.match(
      active,
      /create\s+or\s+replace\s+function\s+(?:public\.)?create_workflow_with_placeholder_media/i
    );

    // 2. Inserts into media without workflow_id
    assert.match(active, /insert\s+into\s+media\s*\(\s*project_id/i);
    const mediaInsertMatch = active.match(/insert\s+into\s+media\s*\(([^)]+)\)/i);
    assert.ok(mediaInsertMatch, "Must find INSERT INTO media statement");
    assert.doesNotMatch(
      mediaInsertMatch[1],
      /\bworkflow_id\b/i,
      "INSERT INTO media column list must NOT contain workflow_id"
    );

    // 3. Atomically links in workflow_media
    assert.match(
      active,
      /insert\s+into\s+workflow_media\s*\(\s*workflow_id\s*,\s*media_id\s*,\s*role\s*\)/i,
      "Must insert into workflow_media relation"
    );
  });
});
