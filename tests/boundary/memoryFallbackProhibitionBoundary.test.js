import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { RunRepository } from "../../src/v2/runner/runRepository.js";

describe("RC1.4-D3(1) — Memory Fallbacks Prohibition Outside Tests", () => {
  let originalNodeEnv;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    RunRepository.useMemoryFallback = false;
    RunRepository.clientOverride = null;
  });

  it("TEST 1: NODE_ENV=production, repository constructed with fallback enabled -> constructor throws", () => {
    process.env.NODE_ENV = "production";
    assert.throws(
      () => new RunRepository({ useMemoryFallback: true }),
      /in-memory fallback is prohibited outside node_env=test/i
    );
  });

  it("TEST 2: NODE_ENV=development, repository constructed with fallback enabled -> constructor throws", () => {
    process.env.NODE_ENV = "development";
    assert.throws(
      () => new RunRepository({ useMemoryFallback: true }),
      /in-memory fallback is prohibited outside node_env=test/i
    );
  });

  it("TEST 3: NODE_ENV=production, DB call rejects -> error propagates and repository did NOT switch to memory", async () => {
    process.env.NODE_ENV = "production";
    const repo = new RunRepository();

    let calls = 0;
    const mockDbError = new Error("Database offline");
    mockDbError.code = "PGRST205"; // The table-not-found code that previously triggered fallback

    RunRepository.clientOverride = {
      from: () => ({
        insert: () => ({
          select: () => ({
            single: async () => {
              calls++;
              return { data: null, error: mockDbError };
            }
          })
        })
      })
    };

    // First call must throw the DB error, NOT swallow it or fall back to memory
    await assert.rejects(
      async () => {
        await repo.createRun({ run_id: "test-run-1", workflow_id: "wf-1" });
      },
      (err) => {
        assert.equal(err.code, "PGRST205");
        return true;
      }
    );

    // Assert repository did NOT switch to memory fallback
    assert.equal(RunRepository.useMemoryFallback, false);

    // Second call must still attempt DB call, not use in-memory Map
    await assert.rejects(
      async () => {
        await repo.createRun({ run_id: "test-run-2", workflow_id: "wf-1" });
      },
      (err) => {
        assert.equal(err.code, "PGRST205");
        return true;
      }
    );

    assert.equal(calls, 2);
    assert.equal(RunRepository.useMemoryFallback, false);
  });

  it("TEST 4: NODE_ENV=test, fallback enabled -> works as before (regression guard)", async () => {
    process.env.NODE_ENV = "test";
    const repo = new RunRepository({ useMemoryFallback: true });
    RunRepository.useMemoryFallback = true;

    const created = await repo.createRun({
      run_id: "test-mem-run-1",
      workflow_id: "wf-test",
      input: { prompt: "test prompt" }
    });

    assert.ok(created);
    assert.equal(created.run_id, "test-mem-run-1");

    const fetched = await repo.getRun("test-mem-run-1");
    assert.ok(fetched);
    assert.equal(fetched.run_id, "test-mem-run-1");
  });

  it("TEST 5: lib/supabase.js with missing env and NODE_ENV=production -> throws at load", () => {
    assert.throws(
      () => {
        execSync(
          'node --input-type=module -e "process.env.DOTENV_CONFIG_PATH=\'nonexistent\'; process.env.NODE_ENV=\'production\'; delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.SUPABASE_KEY; import(\'./lib/supabase.js\');"',
          { stdio: "pipe" }
        );
      },
      (err) => {
        const stderr = err.stderr ? err.stderr.toString() : "";
        return /Fatal: Supabase URL/i.test(stderr) || /supabaseUrl is required/i.test(stderr);
      }
    );
  });

  it("TEST 6: lib/supabase.js with missing env and NODE_ENV=test -> loads successfully with test fake", () => {
    const output = execSync(
      'node --input-type=module -e "process.env.DOTENV_CONFIG_PATH=\'nonexistent\'; process.env.NODE_ENV=\'test\'; delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY; delete process.env.SUPABASE_KEY; import(\'./lib/supabase.js\').then(m => { if (m.supabase && m.supabaseAdmin) console.log(\'TEST_FAKE_LOADED_OK\'); });"',
      { stdio: "pipe" }
    ).toString();

    assert.match(output, /TEST_FAKE_LOADED_OK/);
  });
});
