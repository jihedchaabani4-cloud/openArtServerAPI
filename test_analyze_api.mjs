/**
 * test_analyze_api.mjs
 * Tests the real Next.js /api/elements/analyze endpoint end-to-end.
 *
 * Run: node test_analyze_api.mjs
 * Make sure: my-app (Next.js) is running on http://localhost:3000
 */

const API_URL = "http://localhost:3000/api/elements/analyze";

// Real element IDs from your project
const PROJECT_ID  = "3daf2196-2f09-46f4-a427-08875ea02ffe";
const WORKFLOW_ID = "b509944b-5101-49b9-a5cc-75db988d9856";

// Public test images → will be converted to base64 by the client
const TEST_IMAGE_URLS = [
  "https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600",
  "https://images.unsplash.com/photo-1585386959984-a4155224a1ad?w=600",
];

// ── Convert URLs to base64 (simulates what the browser does) ─────────────────
async function toBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${url}`);
  const buffer = await res.arrayBuffer();
  const b64 = Buffer.from(buffer).toString("base64");
  const mime = res.headers.get("content-type") || "image/jpeg";
  return `data:${mime};base64,${b64}`;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("   /api/elements/analyze — End-to-End API Test     ");
  console.log("═══════════════════════════════════════════════════\n");

  console.log("📥 Converting test images to base64...");
  let base64Images;
  try {
    base64Images = await Promise.all(TEST_IMAGE_URLS.map(toBase64));
    console.log(`   ✅ Converted ${base64Images.length} images\n`);
  } catch (err) {
    console.error("   ❌ Image conversion failed:", err.message);
    process.exit(1);
  }

  const payload = {
    projectId:  PROJECT_ID,
    workflowId: WORKFLOW_ID,
    imageUrls:  base64Images,
    mode:       "character",
  };

  console.log("🚀 POST", API_URL);
  console.log(`   projectId:  ${payload.projectId}`);
  console.log(`   workflowId: ${payload.workflowId}`);
  console.log(`   mode:       ${payload.mode}`);
  console.log(`   images:     ${payload.imageUrls.length} (base64)\n`);

  const startedAt = Date.now();

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const durationMs = Date.now() - startedAt;
    const data = await res.json();

    if (res.ok && data.success) {
      console.log(`✅ SUCCESS! (${durationMs}ms)\n`);
      console.log("📝 Generated Description:");
      console.log("─────────────────────────────────────────────────────");
      console.log(data.description);
      console.log("─────────────────────────────────────────────────────\n");
      console.log("🏷 Extracted Keywords:");
      console.log("─────────────────────────────────────────────────────");
      console.log(Array.isArray(data.keywords) ? data.keywords.map(k => `#${k}`).join(", ") : "None");
      console.log("─────────────────────────────────────────────────────\n");
      console.log(`📊 Stats:`);
      console.log(`   Duration:    ${data.durationMs}ms`);
      console.log(`   Description: ${data.description?.length} chars`);
      console.log(`   Keywords:    ${data.keywords?.length || 0} items`);
      console.log(`   WorkflowId:  ${data.workflowId}`);
    } else {
      console.log(`❌ FAILED — HTTP ${res.status} (${durationMs}ms)`);
      console.log("   Error:", data.error || JSON.stringify(data));
    }
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    console.error(`❌ Request failed (${durationMs}ms):`, err.message);
    console.error("   Is Next.js running on http://localhost:3000?");
  }

  console.log("\n═══════════════════════════════════════════════════");
  console.log("   Test Complete");
  console.log("═══════════════════════════════════════════════════\n");
}

main().catch(console.error);
