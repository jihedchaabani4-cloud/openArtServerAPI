/**
 * Processor: enhancePrompt
 * network: true  ← flagged so compiler elevates retry policy for this pipeline
 *
 * Uses the platform LLM text service to polish and enrich the assembled prompt.
 * This is always the LAST processor in any skill pipeline (per spec §US5 AC-2).
 *
 * Deps injection:
 *   deps.promptService — must expose enhancePrompt(text, options) → Promise<string>
 *                        Falls back to a no-op if the service is unavailable.
 *
 * @param {import('../contracts/context.js').WorkflowContext} context
 * @param {Record<string, unknown>} parameters — optional `enhance` bool (default true)
 * @param {{ promptService?: object }} deps
 * @returns {Promise<import('../contracts/context.js').WorkflowContext>}
 */
export async function run(context, parameters, deps) {
  // Allow skill to opt-out of enhancement at parameter level
  const enabled = parameters?.enhance !== false;
  if (!enabled) return context;

  const rawPrompt = context.prompt ?? "";
  if (!rawPrompt) return context;

  // If no promptService injected (e.g. testing without LLM), pass through
  if (!deps?.promptService?.enhancePrompt) {
    return context;
  }

  let enhancedPrompt = rawPrompt;
  try {
    enhancedPrompt = await deps.promptService.enhancePrompt(rawPrompt, {
      style: context.style,
      layout: context.layout,
    });
  } catch (err) {
    // Degrade gracefully — use the assembled prompt as-is
    console.warn(
      `[enhancePrompt] LLM enhancement failed, using raw prompt: ${err.message}`
    );
  }

  return { ...context, prompt: enhancedPrompt, enhanced: true };
}
