import { randomUUID } from "node:crypto";
import { RunRepository } from "../db/RunRepository.js";
import { db } from "../db/dbMap.js";
import { createLogger, LogEvents } from "#shared";
import { failWorkflowPendingMedia, resolveMediaMetadata } from "#media/tools";
import { calculateCost as defaultCalculateCost } from "#models/tools";
import {
  beginRunBillingAccumulator,
  endRunBillingAccumulator,
  getRunBillingAccumulator,
  estimateNodeBillingAmount,
  isProviderBackedNodeType,
  reserveNodeBilling,
  settleNodeBilling,
  rollbackNodeBilling,
} from "../billing/nodeBilling.js";

let activeGateways = {};
export function initializeGateways(gw = {}) {
  activeGateways = { ...gw };
  return activeGateways;
}
export function getGateways() {
  return activeGateways;
}
import { formatWorkflowError, toRuntimeError } from "../errors/errorPolicy.js";
import { nodeSuccess, nodeFailure } from "../runtime/nodeEnvelope.js";
import {
  registerNodeExecutor as registerMockNode,
  getMockNodeExecutor,
} from "../v3/core/testNodeExecutorRegistry.js";
import {
  imageGenerationV3,
  videoGenerationV3,
  characterSheetV3,
  productVideo4kV3,
} from "../v3/index.js";

const nodeLogger = createLogger("node");
const workflowLogger = createLogger("workflow");
const runRepo = new RunRepository();

// ── Bindings Parser ────────────────────────────────────────────────────────
const INPUT_BINDING = /^\$\{input\.([a-zA-Z_][a-zA-Z0-9_]*)\}$/;
const NODE_OUTPUT_BINDING = /^\$\{([a-zA-Z_][a-zA-Z0-9_-]*)\.output\.([a-zA-Z_][a-zA-Z0-9_.]+)\}$/;

export function isBindingExpression(value) {
  return typeof value === "string" && value.startsWith("${") && value.endsWith("}");
}

export function parseBinding(binding) {
  if (typeof binding !== "string") return null;
  const inputMatch = binding.match(INPUT_BINDING);
  if (inputMatch) {
    return { kind: "input", field: inputMatch[1] };
  }
  const nodeMatch = binding.match(NODE_OUTPUT_BINDING);
  if (nodeMatch) {
    return { kind: "node_output", nodeId: nodeMatch[1], path: nodeMatch[2] };
  }
  return null;
}

export function getValueAtPath(obj, path) {
  if (!obj || !path) return undefined;
  const parts = path.split(".");
  let curr = obj;
  for (const part of parts) {
    if (curr === undefined || curr === null) return undefined;
    curr = curr[part];
  }
  return curr;
}

import { executePromptBuilder as baseExecutePromptBuilder } from "../services/promptBuilderNode.js";

// ── Node Executors Registry & Mocks ────────────────────────────────────────
export async function executePromptBuilder(inputs = {}, ctx = {}) {
  const mock = getMockNodeExecutor("prompt-builder");
  if (mock) return mock(inputs, ctx);
  return baseExecutePromptBuilder(inputs, ctx);
}

export async function executeImageGeneration(inputs = {}, ctx = {}) {
  const mock = getMockNodeExecutor("image-generation");
  if (mock) return mock(inputs, ctx);
  const { run } = await import("#models/tools");
  const model = inputs.model || "nanobana_pro";
  const runResult = await run(model, { prompt: inputs.prompt, ...(inputs.parameters || {}) }, {
    idempotencyKey: `node:${ctx?.runId}:${ctx?.nodeId}`,
    userId: ctx?.userId,
  });
  const rawImages = Array.isArray(runResult.images) ? runResult.images
    : Array.isArray(runResult.data?.images) ? runResult.data.images
    : (runResult.images ? [runResult.images]
    : (runResult.url ? [runResult.url] : []));
  const assets = rawImages.map((img, idx) => ({
    id: `img-${Date.now()}-${idx}`,
    type: "image",
    url: typeof img === "string" ? img : (img?.url || ""),
    metadata: { model, ...(typeof img === "object" ? img : {}) },
  }));
  return {
    image_url: assets[0]?.url || "",
    assets,
    metadata: { model, provider: runResult._internal?.provider || null },
  };
}

export async function executeVideoGeneration(inputs = {}, ctx = {}) {
  const mock = getMockNodeExecutor("video-generation");
  if (mock) return mock(inputs, ctx);
  const { run } = await import("#models/tools");
  const model = inputs.model || "seedance_2_5";
  const runResult = await run(model, { prompt: inputs.prompt, ...(inputs.parameters || {}) }, {
    idempotencyKey: `node:${ctx?.runId}:${ctx?.nodeId}`,
    userId: ctx?.userId,
  });
  const rawVideos = Array.isArray(runResult.videos) ? runResult.videos
    : Array.isArray(runResult.data?.videos) ? runResult.data.videos
    : (runResult.videos ? [runResult.videos]
    : (runResult.url ? [runResult.url] : []));
  const assets = rawVideos.map((vid, idx) => ({
    id: `vid-${Date.now()}-${idx}`,
    type: "video",
    url: typeof vid === "string" ? vid : (vid?.url || ""),
    metadata: { model, ...(typeof vid === "object" ? vid : {}) },
  }));
  return {
    video_url: assets[0]?.url || "",
    assets,
    metadata: { model, provider: runResult._internal?.provider || null },
  };
}

import { NodeSafetyService } from "../services/NodeSafetyService.js";
export { NodeSafetyService };

const llmNodeLogger = createLogger("llm_node");

function renderTemplate(templateStr = "", params = {}) {
  let result = templateStr;
  for (const [key, value] of Object.entries(params)) {
    const regex = new RegExp(`{{\\s*${key}\\s*}}`, "g");
    result = result.replace(regex, String(value));
  }
  return result;
}

function parseJSONResponse(rawText) {
  if (!rawText) throw new Error("Empty LLM response text cannot be parsed as JSON.");

  let cleaned = rawText
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.slice(firstBrace, lastBrace + 1);
  }

  return JSON.parse(cleaned);
}

function normalizeStructuredJSON(parsed, userPrompt = "", { isSafetyActive = false } = {}) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    if (isSafetyActive) {
      const err = new Error("LLM output contract violation: Expected JSON object payload for safety evaluation.");
      err.code = "OUTPUT_CONTRACT_VIOLATION";
      err.category = "UPSTREAM_FAULT";
      err.is_safe = false;
      throw err;
    }
    return {
      is_safe: true,
      safety_reason: null,
      prompt: userPrompt || "",
      description: userPrompt || "",
      title: "",
      keywords: [],
      references: [],
      generationConfig: {},
    };
  }

  if (isSafetyActive) {
    if (typeof parsed.is_safe !== "boolean") {
      const err = new Error("LLM output contract violation: Missing or invalid boolean 'is_safe' field in safety moderation response.");
      err.code = "OUTPUT_CONTRACT_VIOLATION";
      err.category = "UPSTREAM_FAULT";
      err.is_safe = false;
      throw err;
    }
  }

  const isSafe = parsed.is_safe !== false && parsed.safe !== false && parsed.safety !== false;
  const safetyReason = parsed.safety_reason || parsed.reason || (isSafe ? null : "Safety Violation: Prompt contains prohibited sexual or nudity content.");

  const promptText = typeof parsed.description === "string" && parsed.description.trim()
    ? parsed.description.trim()
    : (typeof parsed.prompt === "string" && parsed.prompt.trim()
        ? parsed.prompt.trim()
        : (isSafetyActive ? "" : (userPrompt || "")));

  if (isSafetyActive && isSafe && !promptText) {
    const err = new Error("LLM output contract violation: Safe prompt returned empty description/prompt text.");
    err.code = "OUTPUT_CONTRACT_VIOLATION";
    err.category = "UPSTREAM_FAULT";
    err.is_safe = false;
    throw err;
  }

  return {
    ...parsed,
    is_safe: isSafe,
    safety_reason: safetyReason,
    prompt: promptText,
    description: promptText,
    title: parsed.title ?? "",
    keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
    references: Array.isArray(parsed.references) ? parsed.references : [],
    generationConfig: parsed.generationConfig && typeof parsed.generationConfig === "object"
      ? parsed.generationConfig
      : {},
  };
}

export async function executeLLMNode(resolvedInputs = {}, ctx = {}) {
  const mock = getMockNodeExecutor("llm");
  if (mock) return mock(resolvedInputs, ctx);

  const { nodeId = "llm", runId = "run-1" } = ctx;
  const effectiveUserId = ctx.userId || null;

  const safe = NodeSafetyService.assertLLMInputs(resolvedInputs, nodeId);
  const {
    userPrompt,
    skills: skillIds = [],
    jsonMode = false,
    parameters = {},
    systemPromptOverride = null,
    images = [],
    context = null,
    model = undefined,
  } = safe;

  const isSafetyActive = skillIds.includes("llm/system-safety");

  let systemPrompt = "";
  if (systemPromptOverride) {
    systemPrompt = systemPromptOverride;
  } else {
    const instructions = [];
    for (const id of skillIds) {
      if (id === "llm/system-safety") {
        instructions.push(`STRICT CONTENT SAFETY & ANTI-NUDITY / ANTI-SEXUAL EVALUATION DIRECTIVE:
1. SAFETY VERIFICATION CRITERIA:
Thoroughly inspect the user prompt for any prohibited content: explicit sexual acts, pornography, erotic requests, nudity.
2. SAFETY DECISION & OUTPUT RULE:
If the prompt violates safety policies, you MUST set "is_safe": false and "safety_reason". If safe, set "is_safe": true.`);
      } else {
        instructions.push(`Skill ${id}: process prompt.`);
      }
    }
    systemPrompt = renderTemplate(instructions.join("\n\n---\n\n"), parameters);
  }

  if (context && typeof context === "object") {
    systemPrompt += `\n\n=== RESOLVED CONTEXT SNAPSHOT ===\n${JSON.stringify(context, null, 2)}`;
  }

  if (jsonMode) {
    systemPrompt += `\n\nOUTPUT CONTRACT: You MUST return ONLY a strictly valid JSON object matching this schema:\n{\n  "is_safe": true,\n  "safety_reason": null,\n  "title": "Short title",\n  "description": "Simple, faithful translated prompt text without added embellishments",\n  "keywords": ["tag1", "tag2"],\n  "references": [\n    { "assetId": "id", "role": "character_reference | style_reference | product_reference" }\n  ],\n  "generationConfig": {\n    "aspectRatio": "16:9"\n  }\n}`;
  }

  const { llmService } = await import("#models/tools");

  let result;
  try {
    result = await llmService.generate({
      prompt: userPrompt,
      systemInstruction: systemPrompt,
      images,
      jsonMode,
      userId: effectiveUserId,
      options: resolvedInputs.options || ctx.options || {},
      ...(model ? { model } : {}),
    });
  } catch (llmErr) {
    if (llmErr.code === "BILLING_CONTEXT_MISSING") {
      llmNodeLogger.error({ nodeId, runId }, `Billing context missing for node "${nodeId}" in run "${runId}". Failing node.`);
      throw llmErr;
    }

    const isPolicyViolation =
      llmErr.code === "CONTENT_SAFETY_VIOLATION" ||
      llmErr.code === "PROVIDER_CONTENT_POLICY_ERROR" ||
      /safety|nsfw|sexual|explicit|prohibited content/i.test(llmErr.message || "");

    if (isPolicyViolation) {
      llmNodeLogger.warn({ err: llmErr }, `Content safety policy violation: ${llmErr.message}`);
      const safetyErr = new Error(llmErr.message || "Safety Violation: Prompt contains prohibited content.");
      safetyErr.code = "CONTENT_SAFETY_VIOLATION";
      safetyErr.category = "USER_FAULT";
      safetyErr.statusCode = 422;
      safetyErr.is_safe = false;
      throw safetyErr;
    }

    llmNodeLogger.error({ err: llmErr }, `LLM call failed (${llmErr.message}). Failing closed.`);
    const failErr = new Error(`Content safety verification failed: ${llmErr.message}`);
    failErr.code = llmErr.code && llmErr.code !== "Error" ? llmErr.code : "SAFETY_CHECK_FAILED";
    failErr.category = "UPSTREAM_FAULT";
    failErr.is_safe = false;
    failErr.cause = llmErr;
    throw failErr;
  }

  let jsonOutput = null;

  if (jsonMode) {
    try {
      const rawJson = result.json ?? parseJSONResponse(result.raw);
      jsonOutput = normalizeStructuredJSON(rawJson, userPrompt, { isSafetyActive });
    } catch (firstErr) {
      llmNodeLogger.warn({ model: result.model, err: firstErr }, `[LLMNode] Malformed JSON response from ${result.model}: ${firstErr.message}. Executing 1 retry with reinforced instructions...`);

      const reinforcedInstruction = `${systemPrompt}\n\nCRITICAL ERROR REINFORCEMENT: Your previous output failed JSON parsing. You MUST output ONLY valid JSON without markdown formatting or introductory text.`;

      let retryResult;
      try {
        retryResult = await llmService.generate({
          prompt: userPrompt,
          systemInstruction: reinforcedInstruction,
          images,
          jsonMode: true,
          userId: effectiveUserId,
          options: resolvedInputs.options || ctx.options || {},
        });
      } catch (retryLlmErr) {
        if (retryLlmErr.code === "BILLING_CONTEXT_MISSING") {
          throw retryLlmErr;
        }
        llmNodeLogger.error({ err: retryLlmErr }, `LLM retry call failed (${retryLlmErr.message}). Failing closed.`);
        const retryFailErr = new Error(`Content safety verification failed: ${retryLlmErr.message}`);
        retryFailErr.code = "SAFETY_CHECK_FAILED";
        retryFailErr.category = "UPSTREAM_FAULT";
        retryFailErr.is_safe = false;
        retryFailErr.cause = retryLlmErr;
        throw retryFailErr;
      }

      try {
        const rawJson = retryResult.json ?? parseJSONResponse(retryResult.raw);
        jsonOutput = normalizeStructuredJSON(rawJson, userPrompt, { isSafetyActive });
      } catch (retryErr) {
        llmNodeLogger.error({ err: retryErr }, `Retry failed to parse structured JSON: ${retryErr.message}. Failing closed.`);
        const schemaErr = new Error(`LLM output contract violation: Free text or malformed JSON received when structured safety output was required.`);
        schemaErr.code = isSafetyActive ? "SAFETY_CHECK_FAILED" : "OUTPUT_CONTRACT_VIOLATION";
        schemaErr.category = "UPSTREAM_FAULT";
        schemaErr.is_safe = false;
        schemaErr.cause = retryErr;
        throw schemaErr;
      }
    }
  }

  if (jsonOutput && jsonOutput.is_safe === false) {
    const errorMsg = jsonOutput.safety_reason || "Safety Violation: Prompt contains prohibited content.";
    llmNodeLogger.warn(`Content safety violation: ${errorMsg}`);
    const safetyErr = new Error(errorMsg);
    safetyErr.code = "CONTENT_SAFETY_VIOLATION";
    safetyErr.category = "USER_FAULT";
    safetyErr.statusCode = 422;
    safetyErr.is_safe = false;
    throw safetyErr;
  }

  return {
    text: jsonOutput?.description ?? jsonOutput?.prompt ?? result.raw,
    json: jsonOutput,
    is_safe: jsonOutput?.is_safe ?? true,
    safety_reason: jsonOutput?.safety_reason ?? null,
    modelUsed: result.model,
  };
}

export const executeLLM = executeLLMNode;

const rawRegistry = {
  "prompt-builder": executePromptBuilder,
  "image-generation": executeImageGeneration,
  "video-generation": executeVideoGeneration,
  "llm": executeLLM,
};

export const registry = new Proxy(rawRegistry, {
  set(target, prop, value) {
    target[prop] = value;
    registerMockNode(prop, value);
    return true;
  },
});

export function registerNodeExecutor(type, fn) {
  registry[type] = fn;
}

export async function executeNode(type, resolvedInputs, ctx) {
  const executor = registry[type];
  if (!executor) {
    throw new Error(`No executor found for node type: ${type}`);
  }
  return executor(resolvedInputs, ctx);
}

// ── Persistence ────────────────────────────────────────────────────────────
export async function executeNodePersistence({ nodeConfig, output, run, resolvedInputs, db: dbOverride }) {
  if (!nodeConfig?.persist) return;

  const activeDb = dbOverride || db;
  const { target, step_id, field, value } = nodeConfig.persist;
  const workflowId = run.targetWorkflowId || run.execution_plan?.targetWorkflowId || null;

  const resolvedValue = typeof value === "string" && value.startsWith("$output")
    ? getValueAtPath(output, value.replace(/^\$outputs?\./, ""))
    : value;

  try {
    if ((target === "character" || target === "media") && !workflowId) {
      throw new Error(`Persistence target "${target}" requires server-verified targetWorkflowId on run record`);
    }

    if (target === "character" && workflowId && field) {
      nodeLogger.info({ workflowId, field }, `Updating character ${workflowId} field "${field}"`);
      await activeDb.characters.updateCharacter(workflowId, { [field]: resolvedValue });
    } else if (target === "media" && workflowId) {
      const allowedMediaIds = run.targetMediaIds || run.execution_plan?.targetMediaIds;
      if (!Array.isArray(allowedMediaIds) || allowedMediaIds.length === 0) {
        throw new Error(`Persistence target "media" requires server-verified targetMediaIds on run record`);
      }

      const existingList = await activeDb.media.findByWorkflow(workflowId);
      const placeholders = allowedMediaIds.map((id) => existingList?.find((m) => m.id === id)).filter(Boolean);

      const terminalPlaceholder = placeholders.find((m) => m.status === "failed" || m.status === "cancelled");
      if (terminalPlaceholder) {
        const holdErr = new Error(`Cannot persist completed media for workflow "${workflowId}": placeholder "${terminalPlaceholder.id}" is in terminal status "${terminalPlaceholder.status}" (hold expired or execution was cancelled)`);
        holdErr.code = "HOLD_EXPIRED";
        holdErr.category = "UPSTREAM_FAULT";
        holdErr.statusCode = 409;
        throw holdErr;
      }

      const activePlaceholders = placeholders.filter((m) => m.status === "processing" || m.status === "pending");
      if (activePlaceholders.length !== allowedMediaIds.length) {
        const notFoundErr = new Error(`Cannot persist completed media for workflow "${workflowId}": no authorized active media placeholder found (found ${activePlaceholders.length} of ${allowedMediaIds.length})`);
        notFoundErr.code = "TARGET_MEDIA_NOT_FOUND";
        notFoundErr.category = "SERVER_FAULT";
        notFoundErr.statusCode = 422;
        throw notFoundErr;
      }

      let assets = [];
      if (Array.isArray(output?.assets)) {
        assets = output.assets;
      } else if (output?.assets) {
        assets = [output.assets];
      } else if (Array.isArray(output?.images)) {
        assets = output.images;
      } else if (Array.isArray(output?.videos)) {
        assets = output.videos;
      } else if (typeof resolvedValue === "string" && resolvedValue) {
        assets = [{ url: resolvedValue }];
      } else if (typeof resolvedValue === "object" && resolvedValue?.url) {
        assets = [resolvedValue];
      } else if (output?.media?.url) {
        assets = [{ url: output.media.url }];
      }

      if (assets.length < activePlaceholders.length) {
        for (const placeholder of activePlaceholders) {
          await activeDb.media.updateMedia(placeholder.id, {
            status: "failed",
            error_message: `Output contract violation: expected ${activePlaceholders.length} assets, received ${assets.length}`,
          }).catch(() => {});
        }
        const contractErr = new Error(`Output contract violation: expected ${activePlaceholders.length} assets, received ${assets.length}`);
        contractErr.code = "OUTPUT_CONTRACT_VIOLATION";
        contractErr.category = "SERVER_FAULT";
        contractErr.retryable = false;
        contractErr.statusCode = 422;
        throw contractErr;
      }

      if (assets.length > activePlaceholders.length) {
        assets = assets.slice(0, activePlaceholders.length);
      }

      for (let i = 0; i < assets.length; i++) {
        const asset = assets[i];
        const placeholder = activePlaceholders[i];
        const assetUrl = typeof asset === "string" ? asset : (asset?.url || "");

        if (!assetUrl) {
          for (const p of activePlaceholders) {
            await activeDb.media.updateMedia(p.id, {
              status: "failed",
              error_message: `Output contract violation: asset at index ${i} has empty or missing url`,
            }).catch(() => {});
          }
          const emptyUrlErr = new Error(`Output contract violation: asset at index ${i} has empty or missing url`);
          emptyUrlErr.code = "OUTPUT_CONTRACT_VIOLATION";
          emptyUrlErr.category = "SERVER_FAULT";
          emptyUrlErr.retryable = false;
          emptyUrlErr.statusCode = 422;
          throw emptyUrlErr;
        }

        const mediaMeta = resolveMediaMetadata({
          ...(placeholder?.width && placeholder?.height ? { width: placeholder.width, height: placeholder.height } : {}),
          ...resolvedInputs,
          parameters: resolvedInputs?.parameters,
          ...(typeof asset === "object" ? asset : {}),
        });

        const existingConfig = (placeholder.generation_config && typeof placeholder.generation_config === "object")
          ? placeholder.generation_config
          : null;

        const originalPrompt = existingConfig?.prompt
          || (typeof run?.input?.prompt === "string" ? run.input.prompt.trim() : "")
          || (typeof resolvedInputs?.prompt === "string" ? resolvedInputs.prompt.trim() : "");

        const effectivePrompt = typeof resolvedInputs?.prompt === "string" ? resolvedInputs.prompt.trim() : "";
        const promptOptimized = output?.prompt_optimized || resolvedInputs?.prompt_optimized || ((effectivePrompt && effectivePrompt !== originalPrompt) ? effectivePrompt : undefined);
        const model = output?.metadata?.model || resolvedInputs?.model || run?.input?.model || existingConfig?.model || "unknown";
        const provider = output?.metadata?.provider || output?._internal?.provider || existingConfig?.provider || "unknown";

        const rawParams = (resolvedInputs?.parameters && typeof resolvedInputs.parameters === "object")
          ? resolvedInputs.parameters
          : ((run?.input?.parameters && typeof run.input.parameters === "object") ? run.input.parameters : {});

        const cleanParams = {};
        for (const [k, v] of Object.entries(rawParams)) {
          if (k && !k.match(/secret|token|password|auth|bearer|api[_-]?key/i)) {
            cleanParams[k] = v;
          }
        }

        const generationConfig = {
          ...(existingConfig || {}),
          prompt: originalPrompt,
          ...(promptOptimized !== undefined ? { prompt_optimized: promptOptimized } : {}),
          model,
          provider,
          aspect_ratio: cleanParams.aspect_ratio || existingConfig?.aspect_ratio || run?.input?.aspect_ratio || mediaMeta.aspect_ratio || null,
          parameters: cleanParams,
          created_at: existingConfig?.created_at || new Date().toISOString(),
        };

        const updatePayload = {
          url: assetUrl,
          status: "completed",
          width: mediaMeta.width || placeholder?.width || 1024,
          height: mediaMeta.height || placeholder?.height || 1024,
          generation_config: generationConfig,
        };

        if (typeof activeDb.media.updateMedia === "function") {
          await activeDb.media.updateMedia(placeholder.id, updatePayload);
        } else if (typeof activeDb.media.updateFields === "function") {
          await activeDb.media.updateFields(placeholder.id, updatePayload);
        }
      }
    }
  } catch (err) {
    nodeLogger.error(
      { nodeId: nodeConfig.id, workflowId, err, event: LogEvents.WORKFLOW_NODE_FAILED },
      `Node persistence failed for node "${nodeConfig.id}": ${err.message}`
    );
    const persistenceErr = new Error(`Node "${nodeConfig.id}" persistence failed: ${err.message}`);
    persistenceErr.code = err.code || "PERSISTENCE_FAILED";
    persistenceErr.category = err.category || "SERVER_FAULT";
    persistenceErr.nodeId = nodeConfig.id;
    persistenceErr.retryable = err.retryable !== undefined ? err.retryable : true;
    persistenceErr.cause = err;
    throw persistenceErr;
  }
}

// ── Runner & Orchestrator ──────────────────────────────────────────────────
export async function resolveInputsForNode(run, nodeConfig, nodeRuns) {
  const resolved = { ...(nodeConfig.resolved_inputs || {}) };
  const inputsToResolve = {
    ...(nodeConfig.user_inputs || {}),
    ...(nodeConfig.inputs || {}),
    ...(nodeConfig.bindings || {}),
  };

  for (const [key, expr] of Object.entries(inputsToResolve)) {
    if (typeof expr !== "string") {
      resolved[key] = expr;
      continue;
    }

    const parsed = parseBinding(expr);
    if (!parsed) {
      resolved[key] = expr;
      continue;
    }

    if (parsed.kind === "input") {
      const inputVal = run.input?.[parsed.field];
      if (inputVal !== undefined && inputVal !== null) {
        resolved[key] = inputVal;
      }
    } else if (parsed.kind === "node_output") {
      const depRun = nodeRuns.find((n) => n.node_id === parsed.nodeId);
      resolved[key] = getValueAtPath(depRun?.output, parsed.path);
    }
  }

  return resolved;
}

export async function executeNodeJob(runId, nodeId) {
  const startedAt = Date.now();
  const run = await runRepo.getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found.`);

  const nodeRun = await runRepo.getNodeRun(runId, nodeId);
  if (!nodeRun || nodeRun.status === "completed" || nodeRun.status === "failed") return;

  const nodeConfig = run.execution_plan.nodes.find((n) => n.id === nodeId);
  if (!nodeConfig) throw new Error(`Node configuration for ${nodeId} not found in execution plan.`);

  const nodeRuns = await runRepo.listNodeRuns(runId);
  const isCoveredByUseCase = Boolean(run?.input?.billing_hold_id);
  let billingReservation = null;

  try {
    const resolvedInputs = await resolveInputsForNode(run, nodeConfig, nodeRuns);

    await runRepo.updateNodeRun(runId, nodeId, {
      status: "running",
      started_at: nodeRun.started_at || new Date().toISOString(),
    });

    const billing = await getRunBillingAccumulator(runId);
    const ctx = {
      runId,
      nodeId,
      userId: run.user_id,
      traceId: runId,
      attempt: nodeRun.attempt,
      billing,
    };

    if (isCoveredByUseCase) {
      if (isProviderBackedNodeType(nodeConfig?.type)) {
        const nodeCost = estimateNodeBillingAmount(nodeConfig, resolvedInputs);
        await ctx.billing?.record({
          nodeId,
          nodeType: nodeConfig.type,
          model: resolvedInputs.model,
          amount: nodeCost,
        });
      }
    } else {
      billingReservation = await reserveNodeBilling({
        run,
        nodeConfig,
        resolvedInputs,
        attempt: nodeRun.attempt,
      });
    }

    const output = await executeNode(nodeConfig.type, resolvedInputs, ctx);
    await executeNodePersistence({ nodeConfig, output, run, resolvedInputs });

    if (!isCoveredByUseCase && billingReservation) {
      await settleNodeBilling({ runId, nodeId, nodeConfig, attempt: nodeRun.attempt, reservation: billingReservation });
    }

    const durationMs = Date.now() - startedAt;
    const envelope = nodeSuccess(output, {
      workflowRunId: runId,
      nodeRunId: nodeRun.id,
      nodeId,
      nodeType: nodeConfig.type,
      durationMs,
      modelKey: resolvedInputs.model,
      traceId: runId,
    });

    await runRepo.updateNodeRun(runId, nodeId, {
      status: "completed",
      output: output && typeof output === "object"
        ? { ...output, __nodeEnvelope: envelope }
        : { value: output, __nodeEnvelope: envelope },
      completed_at: new Date().toISOString(),
    });
  } catch (error) {
    if (!isCoveredByUseCase && billingReservation) {
      await rollbackNodeBilling({ runId, nodeId, nodeConfig, attempt: nodeRun.attempt, reservation: billingReservation }).catch(() => {});
    }

    const maxAttempts = nodeConfig?.retry_policy?.max_attempts || 1;
    const currentAttempt = nodeRun?.attempt || 1;

    if (currentAttempt < maxAttempts && error?.retryable !== false) {
      await runRepo.updateNodeRun(runId, nodeId, {
        attempt: currentAttempt + 1,
        status: "pending",
      });
      return executeNodeJob(runId, nodeId);
    }

    const workflowId = run.targetWorkflowId || run.execution_plan?.targetWorkflowId || run?.input?.workflow_id || run?.input?.characterId || null;
    if (workflowId) {
      const sanitized = formatWorkflowError(error);
      await failWorkflowPendingMedia(db, workflowId, sanitized.message).catch(() => {});
    }

    const envelope = nodeFailure(error, {
      workflowRunId: runId,
      nodeRunId: nodeRun.id,
      nodeId,
      nodeType: nodeConfig?.type,
      durationMs: Date.now() - startedAt,
      traceId: runId,
    });
    await runRepo.updateNodeRun(runId, nodeId, {
      status: "failed",
      error: { code: error.code || "NODE_FAILED", message: error.message, envelope },
      completed_at: new Date().toISOString(),
    });
  }
}

export async function executeOrchestration(runId) {
  const run = await runRepo.getRun(runId);
  if (!run || run.status === "completed" || run.status === "failed") return;

  const nodeRuns = await runRepo.listNodeRuns(runId);
  const plan = run.execution_plan;

  if (run.status === "pending") {
    await runRepo.updateRun(runId, { status: "running" });
    run.status = "running";
  }

  const failedNode = nodeRuns.find((n) => n.status === "failed");
  if (failedNode) {
    const rawError = failedNode.error?.envelope?.error || failedNode.error;
    const formattedError = formatWorkflowError(rawError, failedNode);

    await runRepo.updateRun(runId, {
      status: "failed",
      error: formattedError,
      completed_at: new Date().toISOString(),
    }).catch(() => {});

    const targetWfId = run?.targetWorkflowId || run?.execution_plan?.targetWorkflowId || null;
    if (targetWfId) {
      await failWorkflowPendingMedia(db, targetWfId, formattedError.message).catch(() => {});
    }
    return;
  }

  const allCompleted = plan.nodes.every((node) => {
    const nodeRun = nodeRuns.find((n) => n.node_id === node.id);
    return nodeRun && nodeRun.status === "completed";
  });

  if (allCompleted) {
    const outputs = {};
    for (const [key, bindingExpr] of Object.entries(plan.outputs || {})) {
      const parsed = parseBinding(bindingExpr);
      if (parsed && parsed.kind === "node_output") {
        const nodeRun = nodeRuns.find((n) => n.node_id === parsed.nodeId);
        outputs[key] = getValueAtPath(nodeRun?.output, parsed.path);
      } else if (parsed && parsed.kind === "input") {
        outputs[key] = run.input[parsed.field];
      }
    }

    await runRepo.updateRun(runId, {
      status: "completed",
      outputs,
      completed_at: new Date().toISOString(),
    });
    return;
  }

  for (const node of plan.nodes || []) {
    const nodeRun = nodeRuns.find((n) => n.node_id === node.id);
    if (!nodeRun || nodeRun.status !== "pending") continue;

    const deps = (plan.edges || []).filter((e) => e.to === node.id).map((e) => e.from);
    const depsSatisfied = deps.every((depId) => {
      const depRun = nodeRuns.find((n) => n.node_id === depId);
      return depRun && depRun.status === "completed";
    });

    if (depsSatisfied) {
      await runRepo.updateNodeRun(runId, node.id, {
        status: "running",
        started_at: new Date().toISOString(),
      });

      try {
        await executeNodeJob(runId, node.id);
        return await executeOrchestration(runId);
      } catch (err) {
        await runRepo.updateNodeRun(runId, node.id, {
          status: "failed",
          error: { code: "NODE_FAILED", message: err.message },
          completed_at: new Date().toISOString(),
        }).catch(() => {});
        return await executeOrchestration(runId);
      }
    }
  }

  const anyRunning = nodeRuns.some((n) => n.status === "running");
  if (!anyRunning) {
    const deadlockError = { code: "ORCHESTRATION_DEADLOCK", message: "Workflow stuck: no nodes running or ready" };
    await runRepo.updateRun(runId, {
      status: "failed",
      error: deadlockError,
      completed_at: new Date().toISOString(),
    }).catch(() => {});

    const targetWfId = run?.targetWorkflowId || run?.v1_workflow_id || run?.execution_plan?.targetWorkflowId || run?.input?.workflow_id || null;
    if (targetWfId) {
      await failWorkflowPendingMedia(db, targetWfId, deadlockError.message).catch(() => {});
    }
  }
}

export async function startWorkflowRun(plan, runtimeInput, runId = null, serverContext = {}) {
  const finalRunId = runId || randomUUID();
  const billing = beginRunBillingAccumulator(finalRunId);

  const serverWorkflowId = serverContext?.workflowId || runtimeInput?.serverWorkflowId || null;
  const serverMediaIds = serverContext?.mediaIds || runtimeInput?.serverMediaIds || (runtimeInput?.media_id ? [runtimeInput.media_id] : []);
  const serverProjectId = serverContext?.projectId || runtimeInput?.serverProjectId || runtimeInput?.project_id || null;

  try {
    await runRepo.createRun({
      run_id: finalRunId,
      workflow_id: plan.workflow_id,
      workflow_version: plan.workflow_version || "1.0.0",
      user_id: runtimeInput.userId || null,
      status: "pending",
      input: runtimeInput,
      execution_plan: {
        ...plan,
        targetWorkflowId: serverWorkflowId,
        targetMediaIds: serverMediaIds,
        targetProjectId: serverProjectId,
      },
      targetWorkflowId: serverWorkflowId,
      targetMediaIds: serverMediaIds,
      targetProjectId: serverProjectId,
    });

    for (const node of plan.nodes || []) {
      await runRepo.createNodeRun({
        run_id: finalRunId,
        node_id: node.id,
        node_type: node.type,
        status: "pending",
        attempt: 1,
      });
    }

    await executeOrchestration(finalRunId);
  } catch (err) {
    const normalizedErr = {
      message: err.message || "Workflow orchestration failed",
      code: err.code || "ORCHESTRATION_ERROR",
      category: err.category || "SERVER_FAULT",
      retryable: err.retryable ?? false,
    };
    await runRepo.updateRun(finalRunId, {
      status: "failed",
      error: normalizedErr,
      completed_at: new Date().toISOString(),
    }).catch(() => {});

    if (serverWorkflowId) {
      await failWorkflowPendingMedia(db, serverWorkflowId, normalizedErr.message).catch(() => {});
    }
    endRunBillingAccumulator(finalRunId);
    throw err;
  }

  const finalRun = await runRepo.getRun(finalRunId);
  const billingBreakdown = billing.getBreakdown();
  const totalCost = billing.getTotalCost();
  const billingPersistenceFailed = billing.hasPersistenceFailure();
  const billingPersistenceError = billing.getLastPersistenceError()?.message || null;
  endRunBillingAccumulator(finalRunId);

  return {
    run_id: finalRunId,
    status: finalRun?.status || "pending",
    error: finalRun?.error || null,
    outputs: finalRun?.outputs || null,
    billingBreakdown,
    totalCost,
    billingPersistenceFailed,
    billingPersistenceError,
  };
}

// ── Compilers & Registries ─────────────────────────────────────────────────
const CANONICAL_REGISTRIES = {
  workflows: {
    "image-generation-v1": {
      id: "image-generation-v1",
      version: "1.0.0",
      input_schema: {
        required: ["prompt"],
        properties: {
          prompt: { type: "string" },
          model: { type: "string" },
          parameters: { type: "object" },
          characters: { type: "array" },
        },
      },
      nodes: [
        { id: "llm_translate", type: "llm", config: { model: "gemini-3.1-flash-lite" } },
        { id: "generate", type: "image-generation", persist: { target: "media", step_id: "image_generation" } },
      ],
      edges: [{ from: "llm_translate", to: "generate" }],
    },
    "video-generation-v1": {
      id: "video-generation-v1",
      version: "1.0.0",
      input_schema: {
        required: ["prompt"],
        properties: {
          prompt: { type: "string" },
          model: { type: "string" },
          parameters: { type: "object" },
        },
      },
      nodes: [
        { id: "llm_enhance", type: "llm", config: { model: "gemini-3.1-flash-lite" } },
        { id: "generate", type: "video-generation", persist: { target: "media", step_id: "video_generation" } },
      ],
      edges: [{ from: "llm_enhance", to: "generate" }],
    },
    "character-sheet-v1": {
      id: "character-sheet-v1",
      version: "1.0.0",
      input_schema: {
        required: ["prompt"],
        properties: { prompt: { type: "string" }, model: { type: "string" } },
      },
      nodes: (() => {
        const list = [
          {
            id: "llm_enrich",
            type: "llm",
            config: {
              skills: ["llm/system-safety", "llm/character-description"],
              model: "gemini-3.1-flash-lite",
            },
          },
          { id: "generate", type: "image-generation", persist: { target: "media", step_id: "character_sheet" } },
        ];
        list.llm_enrich = list[0];
        list.generate = list[1];
        return list;
      })(),
      edges: [{ from: "llm_enrich", to: "generate" }],
    },
  },
  skills: {},
  processors: {},
};

export function loadRegistries() {
  return CANONICAL_REGISTRIES;
}

export function compileWorkflow(workflowDef, registries = CANONICAL_REGISTRIES) {
  if (!workflowDef) throw new Error("Workflow definition is required for compilation");

  const nodes = workflowDef.nodes || [];
  const edges = workflowDef.edges || [];

  return {
    workflow_id: workflowDef.id || "workflow",
    workflow_version: workflowDef.version || "1.0.0",
    nodes,
    edges,
    outputs: workflowDef.outputs || { result: "${generate.output.url}" },
    adjacency: {},
    parallel_groups: [nodes.map((n) => n.id)],
  };
}

export function compileWorkflowById(workflowId, registries = CANONICAL_REGISTRIES) {
  const def = registries?.workflows?.[workflowId] || CANONICAL_REGISTRIES.workflows[workflowId];
  if (!def) {
    throw new Error(`Workflow "${workflowId}" not found in registries`);
  }
  return compileWorkflow(def, registries);
}

// ── Billing Plan Calculator ────────────────────────────────────────────────
const BILLABLE_TYPES = new Set(["image-generation", "video-generation", "llm"]);

export async function calculateWorkflowBillingPlan({
  plan,
  inputs = {},
  calculateCostFn = defaultCalculateCost,
} = {}) {
  const billableNodes = (plan?.nodes || [])
    .filter((n) => BILLABLE_TYPES.has(n.type))
    .map((node) => {
      const modelKey = node.config?.model || inputs.model || "gemini-3.1-flash-lite";
      const params = (inputs.parameters && typeof inputs.parameters === "object") ? inputs.parameters : {};
      const prompt = inputs.prompt || "";
      const isLLM = node.type === "llm";
      const nodeInput = isLLM
        ? {
            model: modelKey,
            modelKey,
            prompt,
            messages: [{ role: "user", content: prompt }],
          }
        : {
            ...params,
            model: modelKey,
            modelKey,
            prompt,
          };
      return {
        nodeId: node.id,
        nodeType: node.type,
        input: nodeInput,
      };
    });

  const breakdowns = [];
  let totalCredits = 0;

  for (const billable of billableNodes) {
    const modelKey = billable.input.modelKey;
    const costResult = typeof calculateCostFn === "function"
      ? calculateCostFn(modelKey, billable.input)
      : calculateCostFn?.calculateCost?.({ modelKey, input: billable.input });

    const rawCost = typeof costResult === "object" && costResult !== null
      ? (costResult.amount ?? costResult.totalCredits)
      : costResult;

    if (typeof rawCost !== "number" || Number.isNaN(rawCost) || !Number.isFinite(rawCost) || rawCost < 0) {
      const err = new Error(`[Billing] Pricing failure for node "${billable.nodeId}": cost is invalid (${rawCost})`);
      err.code = "PRICING_CONFIG_ERROR";
      err.category = "SERVER_FAULT";
      err.statusCode = 500;
      throw err;
    }

    const credits = Math.ceil(rawCost);
    totalCredits += credits;
    breakdowns.push({
      ...billable,
      cost: {
        totalCredits: credits,
        amount: String(credits),
        currency: "credits",
      },
    });
  }

  return {
    mode: "upfront-reserve",
    totalCredits,
    billableNodes: breakdowns,
  };
}

// ── UseCases Registry & Shims ──────────────────────────────────────────────
export const imageGenerationUseCase = {
  id: "imageGeneration",
  useCaseId: "imageGeneration",
  workflowRef: "image-generation-v1",
  v3Workflow: imageGenerationV3,
  inputSchema: { prompt: { required: true, type: "string" }, model: { required: false, type: "string" } },
};

export const videoGenerationUseCase = {
  id: "videoGeneration",
  useCaseId: "videoGeneration",
  workflowRef: "video-generation-v1",
  v3Workflow: videoGenerationV3,
  inputSchema: { prompt: { required: true, type: "string" }, model: { required: false, type: "string" } },
};

export const characterSheetUseCase = {
  id: "characterSheet",
  useCaseId: "characterSheet",
  workflowRef: "character-sheet-v1",
  v3Workflow: characterSheetV3,
  inputSchema: { prompt: { required: true, type: "string" } },
};

const _useCaseRegistry = new Map([
  ["imageGeneration", imageGenerationUseCase],
  ["videoGeneration", videoGenerationUseCase],
  ["characterSheet", characterSheetUseCase],
  ["image-generation-v1", imageGenerationUseCase],
  ["video-generation-v1", videoGenerationUseCase],
  ["character-sheet-v1", characterSheetUseCase],
]);

export function registerUseCase(id, def) {
  _useCaseRegistry.set(id, def);
}
export function getUseCase(id) {
  return _useCaseRegistry.get(id);
}
export function listUseCases() {
  return Array.from(_useCaseRegistry.values());
}
export function clearUseCaseRegistry() {
  _useCaseRegistry.clear();
}
export function registerAllUseCases() {
  _useCaseRegistry.set("imageGeneration", imageGenerationUseCase);
  _useCaseRegistry.set("videoGeneration", videoGenerationUseCase);
  _useCaseRegistry.set("characterSheet", characterSheetUseCase);
  _useCaseRegistry.set("image-generation-v1", imageGenerationUseCase);
  _useCaseRegistry.set("video-generation-v1", videoGenerationUseCase);
  _useCaseRegistry.set("character-sheet-v1", characterSheetUseCase);
}

export async function runUseCase(useCaseOrParams, input = {}, options = {}) {
  let useCaseId = useCaseOrParams;
  let effectiveInput = input;
  let effectiveOptions = options;
  let registries = options.registries || CANONICAL_REGISTRIES;

  if (useCaseOrParams && typeof useCaseOrParams === "object") {
    useCaseId = useCaseOrParams.useCaseId || useCaseOrParams.id;
    effectiveInput = useCaseOrParams.input || {};
    effectiveOptions = useCaseOrParams;
    registries = useCaseOrParams.registries || CANONICAL_REGISTRIES;
  }

  const def = registries?.workflows?.[useCaseId] || CANONICAL_REGISTRIES.workflows[useCaseId];
  const plan = def ? compileWorkflow(def, registries) : compileWorkflowById(useCaseId, registries);
  const runResult = await startWorkflowRun(plan, effectiveInput, null, effectiveOptions);

  if (!runResult || runResult.status !== "completed") {
    const err = new Error(
      runResult?.error?.message ||
        `Workflow run failed with status: ${runResult?.status || "unknown"}`
    );
    err.code = runResult?.error?.code === "WORKFLOW_INCOMPLETE" ? "WORKFLOW_INCOMPLETE" : "WORKFLOW_FAILED";
    err.category = runResult?.error?.category || "SERVER_FAULT";
    err.billingBreakdown = runResult?.billingBreakdown || [];
    err.error = runResult?.error;
    throw err;
  }

  return runResult;
}
export function getUseCaseRegistries() {
  return CANONICAL_REGISTRIES;
}

// ── Bootstrap & Gateways ───────────────────────────────────────────────────
export function bootstrapV2() {}
export function configureDefaultGateways() {}

// ── Processors (13 pure stubs/delegators for backward compatibility) ────────
export const enhancePrompt = { run: async (input) => input, process: async (input) => input };
export const generateNegativePrompt = { run: async (input) => input, process: async (input) => input };
export const moderationSafety = { run: async (input) => input, process: async (input) => input };
export const optimizeVisualPrompt = { run: async (input) => input, process: async (input) => input };
export const applyCameraStyle = { run: async (input) => input, process: async (input) => input };
export const applyCharacterTemplate = { run: async (input) => input, process: async (input) => input };
export const applyComposition = { run: async (input) => input, process: async (input) => input };
export const applyPoseTemplate = { run: async (input) => input, process: async (input) => input };
export const applySheetLayout = { run: async (input) => input, process: async (input) => input };
export const applyTypographyArea = { run: async (input) => input, process: async (input) => input };
export const buildStoryboardLayout = { run: async (input) => input, process: async (input) => input };
export const resolveCharacters = { run: async (input) => input, process: async (input) => input };
export const resolveReferences = { run: async (input) => input, process: async (input) => input };
