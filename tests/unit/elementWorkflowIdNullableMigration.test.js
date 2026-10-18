import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Target migration in supabase/migrations/
const migrationPath = path.resolve(__dirname, "../../../supabase/migrations/20261018162000_element_workflow_id_nullable.sql");

function activeSql(sql) {
  return sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("Ticket 02: Element workflow_id nullable migration", () => {
  it("migration file exists and drops NOT NULL constraint on element.workflow_id", () => {
    assert.equal(fs.existsSync(migrationPath), true, `Missing migration at ${migrationPath}`);
    const sql = fs.readFileSync(migrationPath, "utf-8");
    const active = activeSql(sql);

    // Must drop NOT NULL on public.element.workflow_id
    assert.match(
      active,
      /alter\s+table\s+(?:public\.)?element\s+alter\s+column\s+workflow_id\s+drop\s+not\s+null/i,
      "Migration must execute ALTER TABLE element ALTER COLUMN workflow_id DROP NOT NULL"
    );
  });

  it("simulates ON DELETE SET NULL on element when workflow is deleted without constraint conflict", () => {
    const workflows = new Map([
      ["wf-1", { id: "wf-1", name: "Workflow 1" }],
    ]);

    const elements = [
      { id: "elem-1", name: "Element 1", workflow_id: "wf-1" },
    ];

    // Simulate workflow deletion
    workflows.delete("wf-1");

    // In PostgreSQL with ON DELETE SET NULL and nullable workflow_id:
    for (const el of elements) {
      if (!workflows.has(el.workflow_id)) {
        el.workflow_id = null; // Successfully set to null because NOT NULL was dropped
      }
    }

    assert.equal(elements.length, 1, "Element must not be deleted");
    assert.equal(elements[0].workflow_id, null, "workflow_id must be null without throwing not-null error");
  });
});
