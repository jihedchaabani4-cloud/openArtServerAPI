import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

const supabaseAdmin = supabaseUrl && supabaseKey
  ? createClient(supabaseUrl, supabaseKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    })
  : null;

const memoryRuns = new Map();
const memoryNodeRuns = new Map(); // key: runId:nodeId

export class RunRepository {
  static useMemoryFallback = false;

  /**
   * Create a new workflow run and optionally initialize its node runs.
   * @param {Object} run
   * @returns {Promise<Object>} The created run
   */
  async createRun(run) {
    if (RunRepository.useMemoryFallback || !supabaseAdmin) {
      const data = {
        run_id: run.run_id || randomUUID(),
        workflow_id: run.workflow_id,
        workflow_version: run.workflow_version,
        user_id: run.user_id || null,
        status: run.status || "pending",
        input: run.input,
        execution_plan: run.execution_plan,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      memoryRuns.set(data.run_id, data);
      return data;
    }

    try {
      const { data, error } = await supabaseAdmin
        .from("v2_workflow_runs")
        .insert({
          run_id: run.run_id,
          workflow_id: run.workflow_id,
          workflow_version: run.workflow_version,
          user_id: run.user_id || null,
          status: run.status || "pending",
          input: run.input,
          execution_plan: run.execution_plan,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .select()
        .single();

      if (error) {
        if (error.code === "PGRST205") {
          RunRepository.useMemoryFallback = true;
          console.warn("⚠️ [RunRepository] v2_workflow_runs table not found in Supabase. Falling back to in-memory storage.");
          return this.createRun(run);
        }
        throw error;
      }
      return data;
    } catch (err) {
      if (err.code === "PGRST205") {
        RunRepository.useMemoryFallback = true;
        console.warn("⚠️ [RunRepository] v2_workflow_runs table not found in Supabase. Falling back to in-memory storage.");
        return this.createRun(run);
      }
      throw err;
    }
  }

  /**
   * Get a run by ID.
   * @param {string} runId
   * @returns {Promise<Object|null>} The run or null
   */
  async getRun(runId) {
    if (RunRepository.useMemoryFallback || !supabaseAdmin) {
      return memoryRuns.get(runId) || null;
    }

    const { data, error } = await supabaseAdmin
      .from("v2_workflow_runs")
      .select("*")
      .eq("run_id", runId)
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  /**
   * Update run fields.
   * @param {string} runId
   * @param {Object} patch
   * @returns {Promise<Object>} The updated run
   */
  async updateRun(runId, patch) {
    if (RunRepository.useMemoryFallback || !supabaseAdmin) {
      const current = memoryRuns.get(runId);
      if (!current) throw new Error(`Run ${runId} not found in memory`);
      const updated = {
        ...current,
        ...patch,
        updated_at: new Date().toISOString()
      };
      memoryRuns.set(runId, updated);
      return updated;
    }

    const { data, error } = await supabaseAdmin
      .from("v2_workflow_runs")
      .update({
        ...patch,
        updated_at: new Date().toISOString()
      })
      .eq("run_id", runId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Create a node run entry.
   * @param {Object} nodeRun
   * @returns {Promise<Object>} The created node run
   */
  async createNodeRun(nodeRun) {
    if (RunRepository.useMemoryFallback || !supabaseAdmin) {
      const data = {
        run_id: nodeRun.run_id,
        node_id: nodeRun.node_id,
        node_type: nodeRun.node_type,
        status: nodeRun.status || "pending",
        attempt: nodeRun.attempt || 1,
        output: nodeRun.output || null,
        error: nodeRun.error || null,
        started_at: nodeRun.started_at || null,
        completed_at: nodeRun.completed_at || null
      };
      memoryNodeRuns.set(`${nodeRun.run_id}:${nodeRun.node_id}`, data);
      return data;
    }

    const { data, error } = await supabaseAdmin
      .from("v2_workflow_run_nodes")
      .insert({
        run_id: nodeRun.run_id,
        node_id: nodeRun.node_id,
        node_type: nodeRun.node_type,
        status: nodeRun.status || "pending",
        attempt: nodeRun.attempt || 1,
        output: nodeRun.output || null,
        error: nodeRun.error || null,
        started_at: nodeRun.started_at || null,
        completed_at: nodeRun.completed_at || null
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * Get a node run status.
   * @param {string} runId
   * @param {string} nodeId
   * @returns {Promise<Object|null>} The node run or null
   */
  async getNodeRun(runId, nodeId) {
    if (RunRepository.useMemoryFallback || !supabaseAdmin) {
      return memoryNodeRuns.get(`${runId}:${nodeId}`) || null;
    }

    const { data, error } = await supabaseAdmin
      .from("v2_workflow_run_nodes")
      .select("*")
      .eq("run_id", runId)
      .eq("node_id", nodeId)
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  /**
   * Update node run fields.
   * @param {string} runId
   * @param {string} nodeId
   * @param {Object} patch
   * @returns {Promise<Object>} The updated node run
   */
  async updateNodeRun(runId, nodeId, patch) {
    if (RunRepository.useMemoryFallback || !supabaseAdmin) {
      const key = `${runId}:${nodeId}`;
      const current = memoryNodeRuns.get(key);
      if (!current) throw new Error(`Node run ${key} not found in memory`);
      const updated = {
        ...current,
        ...patch
      };
      memoryNodeRuns.set(key, updated);
      return updated;
    }

    const { data, error } = await supabaseAdmin
      .from("v2_workflow_run_nodes")
      .update(patch)
      .eq("run_id", runId)
      .eq("node_id", nodeId)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  /**
   * List all node runs for a workflow run.
   * @param {string} runId
   * @returns {Promise<Object[]>} All node runs
   */
  async listNodeRuns(runId) {
    if (RunRepository.useMemoryFallback || !supabaseAdmin) {
      const results = [];
      for (const [key, value] of memoryNodeRuns.entries()) {
        if (key.startsWith(`${runId}:`)) {
          results.push(value);
        }
      }
      return results;
    }

    const { data, error } = await supabaseAdmin
      .from("v2_workflow_run_nodes")
      .select("*")
      .eq("run_id", runId);

    if (error) throw error;
    return data || [];
  }
}
