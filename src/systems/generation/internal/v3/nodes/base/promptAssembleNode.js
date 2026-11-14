import { GenerationValidationError } from "../../../errors.js";

/**
 * PromptAssembleNode (`base.prompt_assemble`)
 *
 * Zero-LLM deterministic prompt & `[Reference Guide]` tag assembler.
 * Combines user prompt, style, and resolved entities (`@Character`, `@Element`, `@imageN`)
 * into a structured generation prompt.
 */
export const PromptAssembleNode = {
  type: "base.prompt_assemble",
  category: "prompt",
  OUTPUT_NODE: false,

  INPUT_TYPES: {
    required: {
      prompt: { type: "STRING" },
    },
    optional: {
      entities: { type: "ARRAY", default: [] },
      style: { type: "STRING", default: "" },
      template_suffix: { type: "STRING", default: "" },
    },
  },

  RETURN_TYPES: {
    final_prompt: "STRING",
    reference_urls: "ARRAY",
    context: "JSON",
  },

  estimateCost: () => 0,

  async execute(inputs) {
    const rawPrompt = typeof inputs.prompt === "string" ? inputs.prompt.trim() : "";
    if (!rawPrompt) {
      throw new GenerationValidationError("prompt must be a non-empty string", { field: "prompt" });
    }

    const entities = Array.isArray(inputs.entities) ? inputs.entities : [];
    const referenceUrls = [];
    const registerUrl = (url) => {
      if (!url || typeof url !== "string" || !url.startsWith("http")) return null;
      let idx = referenceUrls.indexOf(url);
      if (idx === -1) {
        referenceUrls.push(url);
        idx = referenceUrls.length - 1;
      }
      return `@image${idx + 1}`;
    };

    const guideLines = [];
    const entityMentions = [];

    for (const entity of entities) {
      if (!entity || typeof entity !== "object") continue;
      const name = entity.name || "Entity";
      const type = entity.entityType || "reference";
      const urls = Array.isArray(entity.imageUrls) ? entity.imageUrls : [];
      const tags = urls.map(registerUrl).filter(Boolean);

      if (type === "character" || type === "element") {
        const tag = `@${name}`;
        if (!rawPrompt.toLowerCase().includes(tag.toLowerCase())) {
          entityMentions.push(tag);
        }
        const card = [`@${name} (${type})`];
        if (entity.description) {
          card.push(`  description: ${String(entity.description).trim()}`);
        }
        if (Array.isArray(entity.visualTraits) && entity.visualTraits.length > 0) {
          card.push(`  traits: ${entity.visualTraits.join(", ")}`);
        }
        if (tags.length > 0) {
          card.push(`  visual references: ${tags.join(", ")}`);
        }
        guideLines.push(card.join("\n"));
      } else if (tags.length > 0) {
        guideLines.push(`${name} (image reference) — ${tags[0]}`);
      }
    }

    const parts = [];
    if (entityMentions.length > 0) {
      parts.push(entityMentions.join(", "));
    }
    parts.push(rawPrompt);

    if (inputs.style && typeof inputs.style === "string" && inputs.style.trim()) {
      parts.push(inputs.style.trim());
    }
    if (inputs.template_suffix && typeof inputs.template_suffix === "string" && inputs.template_suffix.trim()) {
      parts.push(inputs.template_suffix.trim());
    }

    const guideBlock =
      guideLines.length > 0 ? `\n\n[Reference Guide]\n${guideLines.join("\n\n")}` : "";

    const finalPrompt = `${parts.join(", ")}${guideBlock}`.trim();

    return {
      final_prompt: finalPrompt,
      reference_urls: referenceUrls,
      context: {
        prompt: finalPrompt,
        referenceUrls,
        referenceGuide: guideLines,
      },
    };
  },
};

export default PromptAssembleNode;
