import { loadRegistries } from "../../src/v2/registry/registryLoader.js";
import { createLogger } from "../../src/infrastructure/logging/index.js";

const controllerLogger = createLogger("controller");
import { compileWorkflow } from "../../src/v2/compiler/compileWorkflow.js";
import { startWorkflowRun } from "../../src/v2/runner/workflowRunner.js";
import { RunRepository } from "../../src/v2/runner/runRepository.js";
import { postRunRequestSchema } from "../../src/v2/api/v2ApiSchemas.js";
import { ErrorSystem } from "../../src/runtime/ErrorSystem.js";
import { sanitizeClientError, DEFAULT_APOLOGY_MESSAGE } from "../../src/v2/runtime/errorPolicy.js";

const runRepo = new RunRepository();
let cachedRegistries = null;

function getRegistries() {
  if (!cachedRegistries) {
    cachedRegistries = loadRegistries();
  }
  return cachedRegistries;
}

export async function getHealth(req, res) {
  const started = Date.now();
  const traceId = req.headers["x-trace-id"] || "v2-health";

  try {
    const registries = getRegistries();
    controllerLogger.debug({
      traceId,
      operation: "v2.workflows.health",
      durationMs: Date.now() - started,
    }, "V2 workflows health check ok");

    res.json({
      engine: "v2",
      status: "ok",
      registry_loaded: true,
      compiler_ready: true,
      workflow_count: Object.keys(registries.workflows).length,
      skill_count: Object.keys(registries.skills).length,
    });
  } catch (error) {
    controllerLogger.error({
      traceId,
      operation: "v2.workflows.health",
      durationMs: Date.now() - started,
      err: error,
      errorCode: "REGISTRY_LOAD_FAILED",
    }, `Health check failed: ${error.message}`);
    res.status(503).json({
      engine: "v2",
      status: "degraded",
      registry_loaded: false,
      compiler_ready: false,
      message: error.message,
    });
  }
}

/**
 * Validates dynamic run input payload against workflow input schema.
 */
function validateRunInput(input, inputSchema) {
  if (input.character !== undefined) {
    throw new Error('Singular "character" is not allowed; use "characters" (array).');
  }

  const required = inputSchema.required || [];
  for (const field of required) {
    if (input[field] === undefined) {
      throw new Error(`Missing required input field: "${field}"`);
    }
  }

  for (const [field, val] of Object.entries(input)) {
    const propSchema = inputSchema.properties?.[field];
    if (!propSchema) {
      throw new Error(`Unknown input field: "${field}". This workflow does not accept "${field}" as input.`);
    }

    if (propSchema.type === "array" && !Array.isArray(val)) {
      throw new Error(`Input field "${field}" must be an array`);
    }
    if (propSchema.type === "number" && typeof val !== "number") {
      throw new Error(`Input field "${field}" must be a number`);
    }
    if (propSchema.type === "string" && typeof val !== "string") {
      throw new Error(`Input field "${field}" must be a string`);
    }
    if (propSchema.type === "object" && (typeof val !== "object" || val === null || Array.isArray(val))) {
      throw new Error(`Input field "${field}" must be an object`);
    }
  }
}

/**
 * Resolves model input: applies default_model if workflow has one and user didn't provide.
 */
function resolveModelInput(input, workflow) {
  const schemaProps = workflow.input_schema?.properties || {};
  const hasModelField = schemaProps.model !== undefined;
  const defaultModel = workflow.default_model;
  
  if (input.model !== undefined && !hasModelField) {
    throw new Error(`Workflow "${workflow.id}" does not accept a user-provided model. This workflow uses a fixed server-side model.`);
  }
  
  if (input.model === undefined && defaultModel) {
    return { ...input, model: defaultModel };
  }
  
  return input;
}

export async function submitWorkflowRun(req, res) {
  const started = Date.now();
  const traceId = req.headers["x-trace-id"] || "v2-run-submit";

  // 1. Zod request shape validation
  const parsedBody = postRunRequestSchema.safeParse(req.body);
  if (!parsedBody.success) {
    controllerLogger.warn({
      traceId,
      operation: "v2.workflows.submit",
      durationMs: Date.now() - started,
      errorCode: "INVALID_INPUT",
      err: parsedBody.error,
    }, `Validation failed: ${parsedBody.error.message}`);
    return res.status(400).json({
      code: "INVALID_INPUT",
      message: "Request validation failed",
      errors: parsedBody.error.errors
    });
  }

  const { workflow_id, input } = parsedBody.data;

  try {
    const registries = getRegistries();
    
    // 2. Resolve workflow
    const workflow = registries.workflows[workflow_id];
    if (!workflow) {
      controllerLogger.warn({
        traceId,
        workflow_id,
        operation: "v2.workflows.submit",
        durationMs: Date.now() - started,
        errorCode: "WORKFLOW_NOT_FOUND",
      }, `Workflow "${workflow_id}" not found`);
      return res.status(404).json({
        code: "WORKFLOW_NOT_FOUND",
        message: `Workflow "${workflow_id}" not found`
      });
    }

    // 3. Validate user input against workflow input_schema
    let resolvedInput;
    try {
      validateRunInput(input, workflow.input_schema);
      resolvedInput = resolveModelInput(input, workflow);
    } catch (validationErr) {
      controllerLogger.warn({
        traceId,
        operation: "v2.workflows.submit",
        durationMs: Date.now() - started,
        errorCode: "INVALID_INPUT",
        err: validationErr,
      }, `Validation error: ${validationErr.message}`);
      return res.status(400).json({
        code: "INVALID_INPUT",
        message: validationErr.message
      });
    }

    // 4. Compile workflow to ExecutionGraph
    let plan;
    try {
      plan = compileWorkflow(workflow, registries);
    } catch (compilationErr) {
      controllerLogger.error({
        traceId,
        operation: "v2.workflows.submit",
        durationMs: Date.now() - started,
        errorCode: "COMPILATION_FAILED",
        err: compilationErr,
      }, `Compilation failed: ${compilationErr.message}`);
      return res.status(422).json({
        code: "COMPILATION_FAILED",
        message: compilationErr.message,
        errors: compilationErr.errors || []
      });
    }

    // 5. Start run
    const runtimeInput = {
      ...resolvedInput,
      userId: req.user?.id || null
    };

    const runResult = await startWorkflowRun(plan, runtimeInput);

    controllerLogger.info({
      traceId: runResult.run_id,
      runId: runResult.run_id,
      workflow_id,
      operation: "v2.workflows.submit",
      durationMs: Date.now() - started,
    }, `Successfully submitted workflow run ${runResult.run_id}`);

    res.status(202).json({
      run_id: runResult.run_id,
      status: runResult.status,
      workflow_id: workflow_id
    });

  } catch (err) {
    const report = ErrorSystem.process(err, { traceId });
    controllerLogger.error({
      traceId,
      operation: "v2.workflows.submit",
      durationMs: Date.now() - started,
      errorCode: report.user.code,
      err,
    }, `Submit workflow run failed: ${err.message}`);
    res.status(report.user.statusCode).json(report.user);
  }
}

export async function getWorkflowRunStatus(req, res) {
  const started = Date.now();
  const runId = req.params.run_id;
  const traceId = req.headers["x-trace-id"] || runId || "v2-run-status";

  try {
    const run = await runRepo.getRun(runId);
    if (!run) {
      controllerLogger.warn({
        traceId,
        runId,
        operation: "v2.workflows.status",
        durationMs: Date.now() - started,
        errorCode: "RUN_NOT_FOUND",
      }, `Run ${runId} not found`);
      return res.status(404).json({
        code: "RUN_NOT_FOUND",
        message: "Run not found"
      });
    }

    // Ownership check
    if (run.user_id && req.user?.id && run.user_id !== req.user.id) {
      controllerLogger.warn({
        traceId,
        runId,
        operation: "v2.workflows.status",
        durationMs: Date.now() - started,
        errorCode: "RUN_NOT_FOUND",
      }, `Run ${runId} not owned by authenticated user ${req.user.id}`);
      return res.status(404).json({
        code: "RUN_NOT_FOUND",
        message: "Run not found"
      });
    }

    const nodeRuns = await runRepo.listNodeRuns(runId);
    const nodes = {};
    for (const nodeRun of nodeRuns) {
      nodes[nodeRun.node_id] = {
        status: nodeRun.status,
        attempt: nodeRun.attempt,
        started_at: nodeRun.started_at,
        completed_at: nodeRun.completed_at,
        ...(nodeRun.error ? { error: sanitizeClientError(nodeRun.error) } : {})
      };
    }

    const sanitizedError = run.error ? sanitizeClientError(run.error) : null;

    controllerLogger.debug({
      traceId,
      runId,
      operation: "v2.workflows.status",
      durationMs: Date.now() - started,
    }, `Retrieved status for run ${runId}`);

    res.json({
      run_id: run.run_id,
      workflow_id: run.workflow_id,
      workflow_version: run.workflow_version,
      status: run.status,
      nodes,
      ...(run.outputs ? { outputs: run.outputs } : {}),
      ...(sanitizedError ? { error: sanitizedError } : {}),
      created_at: run.created_at,
      completed_at: run.completed_at
    });

  } catch (err) {
    const report = ErrorSystem.process(err, { traceId, runId });
    controllerLogger.error({
      traceId,
      runId,
      operation: "v2.workflows.status",
      durationMs: Date.now() - started,
      errorCode: report.user.code,
      err,
    }, `Get run status failed: ${err.message}`);
    res.status(report.user.statusCode).json(report.user);
  }
}
