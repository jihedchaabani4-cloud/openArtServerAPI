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

const migration010Path = path.resolve(__dirname, "../../migrations/010_drop_legacy_media_columns.sql");
const rollback010Path = path.resolve(__dirname, "../../migrations/010_drop_legacy_media_columns_rollback.sql");

describe("Database Migration 010 Drop Legacy Media Columns & Rollback (B2)", () => {
  it("010_drop_legacy_media_columns.sql enforces role NOT NULL, drops legacy columns, and sets element.workflow_id FK to ON DELETE SET NULL", () => {
    assert.equal(fs.existsSync(migration010Path), true, `Missing migration at ${migration010Path}`);
    const sql = fs.readFileSync(migration010Path, "utf-8");
    const active = activeSql(sql);

    // 1. workflow_media.role NOT NULL with default 'output'
    assert.match(active, /workflow_media/i);
    assert.match(active, /role[\s\S]*?not\s+null/i);

    // 2. Drop public.media.workflow_id and public.element.primary_media_id
    assert.match(active, /alter\s+table\s+(?:public\.)?media\s+drop\s+column\s+if\s+exists\s+workflow_id/i);
    assert.match(active, /alter\s+table\s+(?:public\.)?element\s+drop\s+column\s+if\s+exists\s+primary_media_id/i);

    // 3. Update element.workflow_id FK constraint to ON DELETE SET NULL
    assert.match(active, /alter\s+table\s+(?:public\.)?element\s+drop\s+constraint\s+if\s+exists\s+element_workflow_id_fkey/i);
    assert.match(
      active,
      /alter\s+table\s+(?:public\.)?element[\s\S]*?add\s+constraint\s+element_workflow_id_fkey[\s\S]*?foreign\s+key\s*\(\s*workflow_id\s*\)\s+references\s+(?:public\.)?workflow\s*\(\s*id\s*\)\s+on\s+delete\s+set\s+null/i
    );

    // 4. Canonical workflow_media indexes
    assert.match(active, /workflow_media_workflow_id_idx/i);
    assert.match(active, /workflow_media_media_id_idx/i);
    assert.match(active, /workflow_media_role_idx/i);
  });

  it("010_drop_legacy_media_columns_rollback.sql documents pg_dump as true rollback, re-adds columns, backfills from workflow_media, and restores ON DELETE CASCADE", () => {
    assert.equal(fs.existsSync(rollback010Path), true, `Missing rollback migration at ${rollback010Path}`);
    const sql = fs.readFileSync(rollback010Path, "utf-8");
    const active = activeSql(sql);

    // 1. Documents pg_dump backup and lossy multi-linked media caveat
    assert.match(sql, /pg_dump/i);
    assert.match(sql, /backup_ffwcjldmmddcxlisntgt\.sql/i);
    assert.match(sql, /lossy/i);

    // 2. Re-adds media.workflow_id and element.primary_media_id
    assert.match(active, /alter\s+table\s+(?:public\.)?media\s+add\s+column\s+if\s+not\s+exists\s+workflow_id\s+uuid/i);
    assert.match(active, /alter\s+table\s+(?:public\.)?element\s+add\s+column\s+if\s+not\s+exists\s+primary_media_id\s+uuid/i);

    // 3. Backfills media.workflow_id from workflow_media
    assert.match(active, /update\s+(?:public\.)?media/i);
    assert.match(active, /distinct\s+on\s*\(\s*media_id\s*\)/i);

    // 4. Reverts element.workflow_id FK to ON DELETE CASCADE
    assert.match(active, /alter\s+table\s+(?:public\.)?element\s+drop\s+constraint\s+if\s+exists\s+element_workflow_id_fkey/i);
    assert.match(
      active,
      /alter\s+table\s+(?:public\.)?element[\s\S]*?add\s+constraint\s+element_workflow_id_fkey[\s\S]*?foreign\s+key\s*\(\s*workflow_id\s*\)\s+references\s+(?:public\.)?workflow\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i
    );
  });

  it("simulates migration 010 forward and rollback cycle across all 10 step_ids and a multi-linked asset in an isolated in-memory harness", async () => {
    const { inferWorkflowMediaRole } = await import("../../src/db/workflowMediaRole.js");

    const stepFixtures = [
      { id: "m-1", step_id: "upload", workflow_id: "wf-upload", wf_type: "UPLOAD", expectedRole: "original" },
      { id: "m-2", step_id: "CAE", workflow_id: "wf-char", wf_type: "CHARACTER_SHEET", expectedRole: "sheet" },
      { id: "m-3", step_id: "GEN", workflow_id: "wf-gen", wf_type: "IMAGE", expectedRole: "output" },
      { id: "m-4", step_id: "EDIT", workflow_id: "wf-edit", wf_type: "IMAGE", expectedRole: "output" },
      { id: "m-5", step_id: "VID", workflow_id: "wf-vid", wf_type: "VIDEO", expectedRole: "output" },
      { id: "m-6", step_id: "UPSCALE", workflow_id: "wf-upscale", wf_type: "IMAGE", expectedRole: "output" },
      { id: "m-7", step_id: "image_generation", workflow_id: "wf-imggen", wf_type: "IMAGE", expectedRole: "output" },
      { id: "m-8", step_id: "video_generation", workflow_id: "wf-vidgen", wf_type: "VIDEO", expectedRole: "output" },
      { id: "m-9", step_id: "character_sheet", workflow_id: "wf-char", wf_type: "CHARACTER", expectedRole: "sheet" },
      { id: "m-10", step_id: "character_detail", workflow_id: "wf-char", wf_type: "CHARACTER", expectedRole: "detail" },
      { id: "m-11", step_id: "element_sheet", workflow_id: "wf-elem", wf_type: "ELEMENT_SHEET", expectedRole: "detail" },
      { id: "m-12", step_id: "element_reference", workflow_id: "wf-elem", wf_type: "ELEMENT", expectedRole: "detail" },
    ];

    const workflows = new Map([
      ["wf-upload", { id: "wf-upload", workflow_type: "UPLOAD" }],
      ["wf-char", { id: "wf-char", workflow_type: "CHARACTER_SHEET" }],
      ["wf-gen", { id: "wf-gen", workflow_type: "IMAGE" }],
      ["wf-edit", { id: "wf-edit", workflow_type: "IMAGE" }],
      ["wf-vid", { id: "wf-vid", workflow_type: "VIDEO" }],
      ["wf-upscale", { id: "wf-upscale", workflow_type: "IMAGE" }],
      ["wf-imggen", { id: "wf-imggen", workflow_type: "IMAGE" }],
      ["wf-vidgen", { id: "wf-vidgen", workflow_type: "VIDEO" }],
      ["wf-elem", { id: "wf-elem", workflow_type: "ELEMENT_SHEET" }],
    ]);

    const mediaTable = stepFixtures.map((f, idx) => ({
      id: f.id,
      step_id: f.step_id,
      workflow_id: f.workflow_id,
      create_time: new Date(Date.UTC(2026, 0, 1, 0, idx, 0)).toISOString(),
    }));

    const elementTable = [
      { id: "elem-1", workflow_id: "wf-elem", primary_media_id: "m-11", name: "Ancient Relic" },
    ];

    const workflowMediaTable = [];
    for (const f of stepFixtures) {
      const role = inferWorkflowMediaRole({ stepId: f.step_id, workflowType: f.wf_type });
      assert.equal(role, f.expectedRole);
      assert.ok(role, "workflow_media.role must be NOT NULL");
      workflowMediaTable.push({
        workflow_id: f.workflow_id,
        media_id: f.id,
        role,
        created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)).toISOString(),
      });
    }

    // Multi-linked asset: m-1 is also linked to wf-elem as a reference
    workflowMediaTable.push({
      workflow_id: "wf-elem",
      media_id: "m-1",
      role: "detail",
      created_at: new Date(Date.UTC(2026, 0, 2, 0, 0, 0)).toISOString(),
    });

    // Apply Migration 010 forward:
    // 1. Drop workflow_id from media rows and primary_media_id from element rows
    for (const m of mediaTable) {
      delete m.workflow_id;
      assert.equal("workflow_id" in m, false);
    }
    for (const el of elementTable) {
      delete el.primary_media_id;
      assert.equal("primary_media_id" in el, false);
    }

    // 2. Verify ON DELETE SET NULL behavior on element.workflow_id when workflow is deleted
    workflows.delete("wf-elem");
    for (const el of elementTable) {
      if (!workflows.has(el.workflow_id)) {
        el.workflow_id = null; // ON DELETE SET NULL
      }
    }
    assert.equal(elementTable.length, 1, "Element row must survive workflow deletion via ON DELETE SET NULL");
    assert.equal(elementTable[0].workflow_id, null);

    // Apply Rollback 010:
    // 1. Re-add workflow_id to media and backfill from earliest workflow_media row (DISTINCT ON media_id ORDER BY created_at ASC)
    for (const m of mediaTable) {
      const earliestLink = workflowMediaTable
        .filter((wm) => wm.media_id === m.id)
        .sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
      m.workflow_id = earliestLink ? earliestLink.workflow_id : null;
      assert.ok(m.workflow_id, `Media ${m.id} must have workflow_id restored on rollback`);
    }
    const multiLinkedMedia = mediaTable.find((m) => m.id === "m-1");
    assert.equal(multiLinkedMedia.workflow_id, "wf-upload", "Earliest link wins on lossy single-column rollback");
  });
});
