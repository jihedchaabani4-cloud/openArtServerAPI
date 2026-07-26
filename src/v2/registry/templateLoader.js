/**
 * templateLoader.js
 *
 * Loads a template YAML file from the templates registry and renders its
 * sections into a plain-text string for injection into the PromptCompilerService
 * system prompt.
 *
 * Template YAML format:
 *   id: character-sheet
 *   label: Character Reference Sheet
 *   sections:
 *     - name: "Front View"
 *       instruction: "Full-body front-facing view..."
 *       order: 1
 */

import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import YAML from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));

const TEMPLATES_DIR = join(__dirname, "templates");

/**
 * Load a template and render its sections into a string.
 *
 * @param {string|null} templateId - Template identifier (e.g. "character-sheet") or null/undefined
 * @returns {Promise<string>} Rendered section text, or empty string if no template
 */
export async function loadTemplate(templateId) {
  if (!templateId) return "";

  const filePath = join(TEMPLATES_DIR, `${templateId}.yaml`);

  let raw;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    throw new Error(`[templateLoader] Template not found: "${templateId}" (expected at ${filePath})`);
  }

  let parsed;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    throw new Error(`[templateLoader] Failed to parse YAML for template "${templateId}": ${err.message}`);
  }

  const sections = parsed?.sections;
  if (!sections?.length) return "";

  // Sort by order ascending
  const sorted = [...sections].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  // Render to plain text
  const rendered = sorted.map((s, i) => {
    const idx = i + 1;
    const name = s.name ?? `Section ${idx}`;
    const instruction = s.instruction ?? "";
    return `Section ${idx} — ${name}:\n${instruction}`;
  });

  return rendered.join("\n\n");
}
