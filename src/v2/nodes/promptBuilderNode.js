/**
 * Prompt Builder Node (T067)
 * skill_aware: true | provider-backed: false
 *
 * Internal pipeline (§09 / plan Phase 5):
 *   1. Parameter Resolver   → initial WorkflowContext from inputs + skill params
 *   2. Source Asset Builder → if source_asset present, build edit context
 *   3. Skill Engine         → load skill, validate params, resolve processor pipeline
 *   4. Processor Engine     → run pipeline sequentially, mutate context in place
 *   5. Context Builder      → merge outputs into final context snapshot
 *   6. Prompt Renderer      → assemble finalPrompt string (NOT an LLM call)
 *
 * Output: { finalPrompt: string, context: WorkflowContext }
 */

import { getProcessor } from "../processors/registry.js";
import { cloneWorkflowContext as deepCopyContext } from "../contracts/context.js";
import { NodeSafetyService } from "./safety/NodeSafetyService.js";

/**
 * Build a description string from a source asset for edit context.
 * Uses metadata, prompt history, or falls back to generic description.
 */
function buildSourceAssetDescription(sourceAsset) {
  if (!sourceAsset) return "";

  // Priority: explicit description > prompt from config > generic
  if (sourceAsset.description) return sourceAsset.description;
  if (sourceAsset.prompt) return sourceAsset.prompt;
  if (sourceAsset.metadata?.prompt) return sourceAsset.metadata.prompt;

  // Fallback based on type
  const type = sourceAsset.type ?? "image";
  return `${type} asset`;
}

/**
 * Build edit-aware prompt prefix that keeps focus on the source asset.
 */
function buildEditPromptPrefix(editContext) {
  const { source_asset, operation } = editContext;
  const desc = source_asset?.description ?? "the image";

  // Format: "[Operation] [description]: [original prompt]"
  // Examples:
  //   "Remove background from: a fluffy orange cat sitting on a couch"
  //   "Add cyberpunk style to: portrait of a young woman"
  //   "Change lighting in: a dark forest scene"

  const parts = [];

  // Operation instruction
  if (operation) {
    parts.push(operation);
  }

  // Source asset description
  if (desc) {
    parts.push(`of ${desc}`);
  }

  return parts.join(" ").trim();
}

/**
 * @param {object} resolvedInputs
 * @param {object} ctx - { runId, nodeId, userId, traceId, registries, deps }
 * @returns {Promise<{ finalPrompt: string, context: object }>}
 */
export async function executePromptBuilder(resolvedInputs, ctx) {
  const { registries, deps = {} } = ctx;

  // ── Safety: validate & sanitise inputs before any context building ────────
  const safe = NodeSafetyService.assertPromptBuilderInputs(
    resolvedInputs,
    ctx.nodeId ?? "prompt-builder",
  );

  // ── Step 1: Parameter Resolver ───────────────────────────────────────────
  // Build initial WorkflowContext from resolved inputs
  const sourceAsset = safe.source_asset;

  const initialContext = deepCopyContext({
    prompt: safe.prompt,
    characters: safe.characters,
    references: safe.references,
    style:      safe.style,
    source_asset: sourceAsset,
    layout: null,
    metadata: {
      runId:  ctx.runId,
      nodeId: ctx.nodeId,
      userId: ctx.userId,
    },
  });

  // ── Step 2: Source Asset Context Builder ─────────────────────────────────
  // If source_asset is present, extract description and build edit context
  if (sourceAsset) {
    const assetDesc = buildSourceAssetDescription(sourceAsset);

    initialContext.edit_context = {
      source_asset: {
        id: sourceAsset.id ?? null,
        url: sourceAsset.url ?? null,
        description: assetDesc,
        type: sourceAsset.type ?? "image",
        width: sourceAsset.width ?? null,
        height: sourceAsset.height ?? null,
      },
      operation: resolvedInputs.prompt ?? "",
    };
  }

  // ── Step 3: Skill Engine ─────────────────────────────────────────────────
  // The skill is already resolved and frozen in the ExecutionGraph.
  // resolvedInputs.skill contains { id, version, pipeline, parameters }
  const skill = resolvedInputs.skill ?? null;
  let processorPipeline = [];
  let skillParameters = {};

  if (skill) {
    const embeddedPipeline = Array.isArray(skill.pipeline) ? skill.pipeline : null;
    const embeddedDefaults = skill.parameter_defaults ?? {};
    const skillDef = registries?.skills?.[skill.id] ?? null;

    if (!skillDef && !embeddedPipeline) {
      throw new Error(
        `Prompt-builder: skill "${skill.id}" not found in registries. Was the workflow compiled correctly?`
      );
    }

    processorPipeline = embeddedPipeline ?? skillDef?.pipeline ?? [];
    // Merge: skill defaults → compiled skill parameters → runtime override
    skillParameters = {
      ...(skillDef?.parameters_schema
        ? Object.fromEntries(
            Object.entries(skillDef.parameters_schema).map(([k, v]) => [
              k,
              v.default,
            ])
          )
        : embeddedDefaults),
      ...(skill.parameters ?? {}),
    };
  }

  // ── Step 4: Processor Engine ─────────────────────────────────────────────
  // Run each processor in order, mutating a working copy of context
  let workingContext = deepCopyContext(initialContext);

  for (const processorName of processorPipeline) {
    const processorFn = getProcessor(processorName);
    // deep-copy input so the processor always receives an independent object
    const inputCtx = deepCopyContext(workingContext);
    const outputCtx = await processorFn(inputCtx, skillParameters, deps);
    // Replace working context with output (processors must return full context)
    workingContext = outputCtx;
  }

  // ── Step 5: Context Builder ──────────────────────────────────────────────
  // Final merge — add skill metadata into context snapshot
  const finalContext = deepCopyContext({
    ...workingContext,
    skill: skill
      ? { id: skill.id, version: skill.version }
      : null,
  });

  // ── Step 6: Prompt Renderer ──────────────────────────────────────────────
  // Assemble the final prompt string from the assembled context.
  // This is pure string assembly — NOT an LLM call.
  const parts = [];

  // If edit context exists, prepend edit-aware prefix
  if (finalContext.edit_context) {
    const editPrefix = buildEditPromptPrefix(finalContext.edit_context);
    if (editPrefix) {
      parts.push(editPrefix);
    }
  } else {
    // Standard generation: use prompt directly
    if (finalContext.prompt) {
      parts.push(finalContext.prompt);
    }
  }

  // Add style if present and not already included
  if (finalContext.style && !parts.some(p => p.includes(finalContext.style))) {
    parts.push(finalContext.style);
  }

  const finalPrompt = parts.join(", ").trim();

  if (!finalPrompt) {
    throw new Error(
      "Prompt builder produced an empty finalPrompt. Check skill pipeline and input prompt."
    );
  }

  return {
    finalPrompt,
    context: finalContext,
  };
}
