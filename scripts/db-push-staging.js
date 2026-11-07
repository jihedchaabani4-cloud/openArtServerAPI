import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const EXPECTED_STAGING_REF = "uedyifxpddbpgjptuhwo";
const FORBIDDEN_LIVE_REF = "ffwcjldmmddcxlisntgt";
const TEMP_REF_FILE = path.join(rootDir, "supabase", ".temp", "project-ref");
const ENV_STAGING_FILE = path.join(rootDir, ".env.staging.local");

// 1. Guard check: read linked project ref
if (!fs.existsSync(TEMP_REF_FILE)) {
  console.error("❌ ERROR: No linked Supabase project found.");
  console.error(`   Run \`supabase link --project-ref ${EXPECTED_STAGING_REF}\` first.`);
  process.exit(1);
}

const currentRef = fs.readFileSync(TEMP_REF_FILE, "utf8").trim();

if (currentRef === FORBIDDEN_LIVE_REF) {
  console.error("❌ CRITICAL SAFETY ABORT: Attempting to target LIVE project [ffwcjldmmddcxlisntgt]! Execution halted immediately.");
  process.exit(1);
}

if (!currentRef || currentRef !== EXPECTED_STAGING_REF) {
  console.error("❌ FATAL SAFETY GUARD ABORT:");
  console.error(`   Linked project ref [${currentRef}] does NOT match approved staging ref [${EXPECTED_STAGING_REF}].`);
  console.error("   Aborting to prevent touching live or unexpected databases.");
  process.exit(1);
}

console.log(`✅ Staging guard verified: linked to approved staging project [${currentRef}].`);

// 2. Load DB password from .env.staging.local if present
let dbPassword = process.env.SUPABASE_DB_PASSWORD || "";
if (fs.existsSync(ENV_STAGING_FILE)) {
  const content = fs.readFileSync(ENV_STAGING_FILE, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("SUPABASE_DB_PASSWORD=")) {
      const val = trimmed.slice("SUPABASE_DB_PASSWORD=".length).trim();
      if (val) dbPassword = val;
    }
  }
}

// 3. Step 1: Run dry-run first
console.log("▶ Running: supabase db push --dry-run ...");
try {
  const env = {
    ...process.env,
    PATH: `${process.env.USERPROFILE}\\scoop\\shims;${process.env.PATH}`,
    ...(dbPassword ? { SUPABASE_DB_PASSWORD: dbPassword } : {}),
  };
  execSync("supabase db push --dry-run", {
    cwd: rootDir,
    stdio: "inherit",
    env,
  });
} catch (err) {
  console.error("❌ Dry-run failed. Aborting push.");
  process.exit(1);
}

// 4. Step 2: If dry-run passes and --execute flag is passed, run the real push
const isRealPush = process.argv.includes("--execute");
if (!isRealPush) {
  console.log("\n💡 Dry-run completed successfully.");
  console.log("   To perform the actual push to staging, re-run with: node scripts/db-push-staging.js --execute");
  process.exit(0);
}

console.log("\n▶ Running: supabase db push ...");
try {
  const env = {
    ...process.env,
    PATH: `${process.env.USERPROFILE}\\scoop\\shims;${process.env.PATH}`,
    ...(dbPassword ? { SUPABASE_DB_PASSWORD: dbPassword } : {}),
  };
  execSync("supabase db push", {
    cwd: rootDir,
    stdio: "inherit",
    env,
  });
  console.log("✅ Staging db push completed successfully.");
} catch (err) {
  console.error("❌ Staging db push failed.");
  process.exit(1);
}
