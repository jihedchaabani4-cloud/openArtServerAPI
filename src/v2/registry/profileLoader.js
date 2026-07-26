/**
 * profileLoader.js
 *
 * Loads a Use Case Profile YAML file from the profiles registry.
 *
 * Profile YAML format:
 *   id: simple-image
 *   mediaType: image
 *   template: null
 *   requiresPrompt: true
 *   defaultPrompt: ""
 *   skills:
 *     - base-generation
 */

import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import YAML from "yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PROFILES_DIR = join(__dirname, "profiles");

/**
 * @typedef {Object} Profile
 * @property {string} id
 * @property {'image'|'video'} mediaType
 * @property {string|null} template
 * @property {boolean} requiresPrompt
 * @property {string} defaultPrompt
 * @property {string[]} skills
 */

/**
 * Load a use case profile by ID.
 *
 * @param {string} profileId - Profile identifier (e.g. "simple-image")
 * @returns {Promise<Profile>}
 */
export async function loadProfile(profileId) {
  const filePath = join(PROFILES_DIR, `${profileId}.yaml`);

  let raw;
  try {
    raw = await readFile(filePath, "utf-8");
  } catch (err) {
    throw new Error(`[profileLoader] Profile not found: "${profileId}" (expected at ${filePath})`);
  }

  let parsed;
  try {
    parsed = YAML.parse(raw);
  } catch (err) {
    throw new Error(`[profileLoader] Failed to parse YAML for profile "${profileId}": ${err.message}`);
  }

  // Normalize with safe defaults
  return {
    id:             parsed.id             ?? profileId,
    mediaType:      parsed.mediaType      ?? "image",
    template:       parsed.template       ?? null,
    requiresPrompt: parsed.requiresPrompt ?? true,
    defaultPrompt:  parsed.defaultPrompt  ?? "",
    skills:         Array.isArray(parsed.skills) ? parsed.skills : [],
  };
}
