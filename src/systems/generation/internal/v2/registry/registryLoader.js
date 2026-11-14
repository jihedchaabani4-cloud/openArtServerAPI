import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {string} filePath
 */
function readYamlFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return YAML.parse(raw);
}

/**
 * @param {string} [registryRoot]
 */
export function loadRegistries(registryRoot = path.join(__dirname, ".")) {
  const nodesPath = path.join(registryRoot, "nodes.yaml");
  const processorsPath = path.join(registryRoot, "processors.yaml");
  const skillsDir = path.join(registryRoot, "skills");
  const workflowsDir = path.join(registryRoot, "workflows");

  if (!fs.existsSync(nodesPath)) {
    throw new Error(`Node registry not found: ${nodesPath}`);
  }
  if (!fs.existsSync(processorsPath)) {
    throw new Error(`Processor registry not found: ${processorsPath}`);
  }

  /** @type {Record<string, import('../contracts/node.js').NodeRegistryEntry>} */
  const nodes = readYamlFile(nodesPath);

  /** @type {Record<string, import('../contracts/processor.js').ProcessorRegistryEntry>} */
  const processorsRaw = readYamlFile(processorsPath);
  /** @type {Record<string, import('../contracts/processor.js').ProcessorRegistryEntry>} */
  const processors = {};
  for (const [name, entry] of Object.entries(processorsRaw)) {
    processors[name] = { name, ...entry };
    if (typeof processors[name].network !== "boolean") {
      throw new Error(`Processor "${name}" must declare network: true|false.`);
    }
  }

  /** @type {Record<string, import('../contracts/skill.js').SkillDefinition>} */
  const skills = {};

  function readSkillsRecursively(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        readSkillsRecursively(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".yaml")) {
        const skill = readYamlFile(fullPath);
        if (!skill?.id) {
          throw new Error(`Skill file ${fullPath} missing id.`);
        }
        skills[skill.id] = skill;
        for (const processorName of skill.pipeline || []) {
          if (!processors[processorName]) {
            throw new Error(`Skill "${skill.id}" references unknown processor "${processorName}".`);
          }
        }
        for (const nodeType of skill.applies_to || []) {
          if (!nodes[nodeType]) {
            throw new Error(`Skill "${skill.id}" applies_to unknown node type "${nodeType}".`);
          }
        }
      }
    }
  }

  readSkillsRecursively(skillsDir);

  /** @type {Record<string, import('../contracts/workflow.js').WorkflowDefinition>} */
  const workflows = {};
  for (const file of fs.readdirSync(workflowsDir)) {
    if (!file.endsWith(".yaml")) continue;
    const workflow = readYamlFile(path.join(workflowsDir, file));
    if (!workflow?.id) {
      throw new Error(`Workflow file ${file} missing id.`);
    }
    workflows[workflow.id] = workflow;
  }

  return { nodes, processors, skills, workflows, registryRoot };
}

export function getRegistryRoot() {
  return path.join(__dirname, ".");
}
