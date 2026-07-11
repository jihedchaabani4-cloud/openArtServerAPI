import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function runNodeScript(relativePath, args = []) {
  const scriptPath = path.join(__dirname, relativePath);
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: path.resolve(__dirname, "../.."),
    stdio: "inherit",
  });

  if (result.status !== 0) {
    throw new Error(`[v2:validate] ${relativePath} failed with exit code ${result.status}.`);
  }
}

function runNpmScript(scriptName) {
  const result = spawnSync(`npm run ${scriptName}`, {
    cwd: path.resolve(__dirname, "../.."),
    stdio: "inherit",
    shell: true,
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`[v2:validate] npm run ${scriptName} failed with exit code ${result.status}.`);
  }
}

function main() {
  const phaseChecks = [
    ["checkV1Untouched.mjs"],
    ["checkRegistryLoad.mjs"],
    ["checkCompiler.mjs", "--mode", "all"],
    ["checkRunner.mjs"],
    ["checkRetryFallback.mjs"],
    ["checkPromptBuilder.mjs"],
    ["checkImageWorkflow.mjs"],
    ["checkVideoWorkflow.mjs"],
    ["checkComposability.mjs"],
  ];

  for (const [script, ...args] of phaseChecks) {
    console.log(`[v2:validate] Running ${script} ${args.join(" ")}`.trim());
    runNodeScript(script, args);
  }

  console.log("[v2:validate] Running architecture:validate");
  runNpmScript("architecture:validate");
  console.log("[v2:validate] PASS");
}

main();
