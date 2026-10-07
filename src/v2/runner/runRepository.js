import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { logger } from "../../runtime/logger.js";

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
  static clientOverride = null;

  constructor(options = {}) {
    const fallbackRequested = options?.useMemoryFallback || RunRepository.useMemoryFallback;
    if (fallbackRequested && process.env.NODE_ENV !== "test") {
      logger.error({ module: "RUN_REPO", event: "memory_fallback_rejected" }, "In-memory fallback is prohibited outside NODE_ENV=test");
      throw new Error("In-memory fallback is prohibited outside NODE_ENV=test");
    }
  }

  _isMemoryMode() {
    if (process.env.NODE_ENV !== "test") {
      if (RunRepository.useMemoryFallback) {
        throw new Error("In-memory fallback is prohibited outside NODE_ENV=test");
      }
      return false;
    }
    return Boolean(RunRepository.useMemoryFallback || !this.getClient());
  }

  getClient() {
    const client = RunRepository.clientOverride || supabaseAdmin;
    if (!client && process.env.NODE_ENV !== "test") {
      throw new Error("Supabase client is required in non-test mode");
    }
    return client;
  }

  _normalizeRunRow(data) {
    if (!data) return null;
    const v1WorkflowId = data.v1_workflow_id !== undefined && data.v1_workflow_id !== null
      ? data.v1_workflow_id
      : (data.execution_plan?.targetWorkflowId || null);

    const targetMediaIds = Array.isArray(data.target_media_ids) && data.target_media_ids.length > 0
      ? data.target_media_ids
      : (Array.isArray(data.execution_plan?.targetMediaIds) && data.execution_plan.targetMediaIds.length > 0
          ? data.execution_plan.targetMediaIds
          : (Array.isArray(data.target_media_ids) ? data.target_media_ids : []));

    const metadata = data.metadata || data.execution_plan?.metadata || {};

    data.v1_workflow_id = v1WorkflowId;
    data.target_media_ids = targetMediaIds;
    data.targetWorkflowId = v1WorkflowId;
    data.targetMediaIds = targetMediaIds;
    data.metadata = metadata;
    return data;
  }

  /**
   * Create a new workflow run and optionally initialize its node runs.
   * @param {Object} run
   * @returns {Promise<Object>} The created run
   */
  async createRun(run) {
    const v1WorkflowId = run.v1_workflow_id !== undefined
      ? run.v1_workflow_id
      : (run.targetWorkflowId || null);
    const targetMediaIds = run.target_media_ids !== undefined
      ? run.target_media_ids
      : (run.targetMediaIds || []);
    const metadata = run.metadata || {};

    const client = this.getClient();

    if (this._isMemoryMode()) {
      const data = {
        run_id: run.run_id || randomUUID(),
        workflow_id: run.workflow_id,
        workflow_version: run.workflow_version,
        user_id: run.user_id || null,
        status: run.status || "pending",
        input: run.input,
        execution_plan: run.execution_plan || {},
        metadata,
        v1_workflow_id: v1WorkflowId,
        target_media_ids: targetMediaIds,
        targetWorkflowId: v1WorkflowId,
        targetMediaIds: targetMediaIds,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      memoryRuns.set(data.run_id, data);
      return data;
    }

    try {
      const { data, error } = await client
        .from("v2_workflow_runs")
        .insert({
          run_id: run.run_id,
          workflow_id: run.workflow_id,
          workflow_version: run.workflow_version,
          user_id: run.user_id || null,
          status: run.status || "pending",
          input: run.input,
          execution_plan: run.execution_plan || {},
          metadata,
          v1_workflow_id: v1WorkflowId,
          target_media_ids: targetMediaIds,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        })
        .select()
        .single();

      if (error) {
        if (error.code === "PGRST205") {
          if (process.env.NODE_ENV !== "test") {
            logger.error({ module: "RUN_REPO", err: error, event: "table_missing_fatal" }, "v2_workflow_runs table missing in non-test mode");
            throw error;
          }
          RunRepository.useMemoryFallback = true;
          logger.warn({ module: "RUN_REPO", event: "test_fallback" }, "v2_workflow_runs table not found in Supabase. Falling back to in-memory storage.");
          return this.createRun(run);
        }
        throw error;
      }
      return this._normalizeRunRow(data);
    } catch (err) {
      if (err.code === "PGRST205") {
        if (process.env.NODE_ENV !== "test") {
          logger.error({ module: "RUN_REPO", err, event: "table_missing_fatal" }, "v2_workflow_runs table missing in non-test mode");
          throw err;
        }
        RunRepository.useMemoryFallback = true;
        logger.warn({ module: "RUN_REPO", event: "test_fallback" }, "v2_workflow_runs table not found in Supabase. Falling back to in-memory storage.");
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
    const client = this.getClient();
    if (this._isMemoryMode()) {
      const run = memoryRuns.get(runId) || null;
      return this._normalizeRunRow(run);
    }

    const { data, error } = await client
      .from("v2_workflow_runs")
      .select("*")
      .eq("run_id", runId)
      .maybeSingle();

    if (error) throw error;
    return this._normalizeRunRow(data);
  }

  /**
   * Update run fields.
   * @param {string} runId
   * @param {Object} patch
   * @returns {Promise<Object>} The updated run
   */
  async updateRun(runId, patch) {
    const client = this.getClient();
    if (this._isMemoryMode()) {
      const current = memoryRuns.get(runId);
      if (!current) throw new Error(`Run ${runId} not found in memory`);
      const updated = {
        ...current,
        ...patch,
        updated_at: new Date().toISOString()
      };
      const normalized = this._normalizeRunRow(updated);
      memoryRuns.set(runId, normalized);
      return normalized;
    }

    const { data, error } = await client
      .from("v2_workflow_runs")
      .update({
        ...patch,
        updated_at: new Date().toISOString()
      })
      .eq("run_id", runId)
      .select()
      .single();

    if (error) throw error;
    return this._normalizeRunRow(data);
  }

  /**
   * Create a node run entry.
   * @param {Object} nodeRun
   * @returns {Promise<Object>} The created node run
   */
  async createNodeRun(nodeRun) {
    const client = this.getClient();
    if (this._isMemoryMode()) {
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

    const { data, error } = await client
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
    const client = this.getClient();
    if (this._isMemoryMode()) {
      return memoryNodeRuns.get(`${runId}:${nodeId}`) || null;
    }

    const { data, error } = await client
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
    const client = this.getClient();
    if (this._isMemoryMode()) {
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

    const { data, error } = await client
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
    const client = this.getClient();
    if (this._isMemoryMode()) {
      const results = [];
      for (const [key, value] of memoryNodeRuns.entries()) {
        if (key.startsWith(`${runId}:`)) {
          results.push(value);
        }
      }
      return results;
    }

    const { data, error } = await client
      .from("v2_workflow_run_nodes")
      .select("*")
      .eq("run_id", runId);

    if (error) throw error;
    return data || [];
  }
}
