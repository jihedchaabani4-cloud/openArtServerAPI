import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { WorkflowValidationError } from "../errors.js";

const SKILLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/;

export function normalizeSkillName(skill) {
  if (typeof skill !== "string") return "";
  return skill.trim().toLowerCase().replace(/^llm\//, "");
}

function parseSkillMarkdown(raw, filePath) {
  const normalized = String(raw || "").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const match = normalized.match(FRONTMATTER_REGEX);
  if (!match) {
    throw new WorkflowValidationError(
      `Invalid SKILL.md format in "${filePath}": missing YAML frontmatter delimiters`,
      { field: "skills", context: { filePath } }
    );
  }

  const frontmatter = parseYaml(match[1]);
  if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) {
    throw new WorkflowValidationError(
      `Invalid SKILL.md frontmatter in "${filePath}": expected YAML mapping`,
      { field: "skills", context: { filePath } }
    );
  }

  const id = normalizeSkillName(frontmatter.name);
  if (!id) {
    throw new WorkflowValidationError(
      `Invalid SKILL.md frontmatter in "${filePath}": "name" is required`,
      { field: "skills", context: { filePath } }
    );
  }

  const instruction = match[2].trim();
  if (!instruction) {
    throw new WorkflowValidationError(
      `Invalid SKILL.md in "${filePath}": markdown body must be non-empty`,
      { field: "skills", context: { filePath } }
    );
  }

  const rawAliases = Array.isArray(frontmatter.aliases) ? frontmatter.aliases : [];
  const aliases = Object.freeze([
    ...new Set(rawAliases.map(normalizeSkillName).filter((alias) => alias && alias !== id)),
  ]);
  const description =
    typeof frontmatter.description === "string" ? frontmatter.description.trim() : "";
  const guard =
    typeof frontmatter.guard === "string" && frontmatter.guard.trim()
      ? frontmatter.guard.trim().toLowerCase()
      : null;

  return Object.freeze({
    id,
    name: id,
    aliases,
    description,
    guard,
    requiresSafetyCheck: guard === "safety",
    requiresJson: Boolean(frontmatter.json),
    instruction,
  });
}

function loadSkillsRegistry() {
  const registry = {};
  const entries = readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    const skillPath = path.join(SKILLS_DIR, entry.name, "SKILL.md");
    if (!existsSync(skillPath)) continue;

    const raw = readFileSync(skillPath, "utf8");
    const spec = parseSkillMarkdown(raw, skillPath);

    for (const key of [spec.id, ...spec.aliases]) {
      if (Object.prototype.hasOwnProperty.call(registry, key)) {
        throw new WorkflowValidationError(
          `Duplicate LLM skill key "${key}" detected while loading "${skillPath}"`,
          { field: "skills", context: { skill: key, filePath: skillPath } }
        );
      }
      registry[key] = spec;
    }
  }

  return Object.freeze(registry);
}

export const LLM_SKILLS_REGISTRY = loadSkillsRegistry();

const SKILL_NAMES = Object.freeze(Object.keys(LLM_SKILLS_REGISTRY).sort());

export function getSkill(name) {
  const normalized = normalizeSkillName(name);
  if (!normalized || !Object.prototype.hasOwnProperty.call(LLM_SKILLS_REGISTRY, normalized)) {
    return null;
  }
  return LLM_SKILLS_REGISTRY[normalized];
}

export function listSkills() {
  return SKILL_NAMES;
}

export function buildUnifiedLlmInstruction(skills = []) {
  if (!Array.isArray(skills)) {
    throw new WorkflowValidationError("skills must be an array of registered skill names", {
      field: "skills",
      context: { skill: skills },
    });
  }

  const activeSpecs = [];
  const seenIds = new Set();

  for (const rawSkill of skills) {
    if (typeof rawSkill !== "string" || !rawSkill.trim()) {
      throw new WorkflowValidationError(
        `Invalid LLM skill "${String(rawSkill)}": expected a non-empty registered skill name`,
        { field: "skills", context: { skill: rawSkill } }
      );
    }

    const normalized = normalizeSkillName(rawSkill);
    const spec = getSkill(normalized);
    if (!spec) {
      throw new WorkflowValidationError(
        `Unknown LLM skill "${rawSkill}". Registered skills: ${SKILL_NAMES.join(", ")}`,
        { field: "skills", context: { skill: rawSkill } }
      );
    }

    if (!seenIds.has(spec.id)) {
      seenIds.add(spec.id);
      activeSpecs.push(spec);
    }
  }

  const requiresSafety = activeSpecs.some((s) => s.requiresSafetyCheck);
  const useJsonMode = activeSpecs.some((s) => s.requiresJson) || requiresSafety;
  const activeSkills = activeSpecs.map((s) => s.id);

  const blocks = [];
  if (activeSpecs.length > 0) {
    blocks.push("Apply the following active skills in order:");
    for (const spec of activeSpecs) {
      blocks.push(`<skill name="${spec.id}">\n${spec.instruction}\n</skill>`);
    }
  }

  if (useJsonMode) {
    blocks.push(
      "Respond with ONLY a single valid JSON object containing all fields specified by the active skills above (no markdown fences or extra commentary)."
    );
  }

  return {
    systemInstruction: blocks.join("\n\n"),
    requiresSafety,
    useJsonMode,
    activeSkills,
  };
}

export default LLM_SKILLS_REGISTRY;
