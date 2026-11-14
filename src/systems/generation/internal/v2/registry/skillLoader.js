/**
 * skillLoader.js
 *
 * Loads one or more skill YAML files from the skills registry and concatenates
 * their `prompt_instruction` fields into a single string for use in the
 * PromptCompilerService system prompt.
 *
 * Skill IDs support subdirectories: "camera/orbit" → skills/camera/orbit.yaml
 */

import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import YAML from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Resolve the skills directory relative to this file
const SKILLS_DIR = join(__dirname, "skills");

/**
 * Load and concatenate skill instructions for a list of skill IDs.
 *
 * @param {string[]} skillIds - Ordered list of skill IDs to load (e.g. ["camera/orbit", "lighting/cinematic"])
 * @returns {Promise<string>} Concatenated prompt_instruction strings, separated by "---"
 */
export async function loadSkills(skillIds) {
  if (!skillIds?.length) return "";

  const instructions = [];

  for (const id of skillIds) {
    // Support subdir IDs like "camera/orbit" → "camera/orbit.yaml"
    const filePath = join(SKILLS_DIR, `${id}.yaml`);

    let raw;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (err) {
      throw new Error(`[skillLoader] Skill not found: "${id}" (expected at ${filePath})`);
    }

    let parsed;
    try {
      parsed = YAML.parse(raw);
    } catch (err) {
      throw new Error(`[skillLoader] Failed to parse YAML for skill "${id}": ${err.message}`);
    }

    const instruction = parsed?.prompt_instruction;
    if (instruction) {
      instructions.push(instruction.trim());
    }
  }

  return instructions.join("\n\n---\n\n");
}
