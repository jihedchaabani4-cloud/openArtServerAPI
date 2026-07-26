/**
 * test_element_analysis.mjs
 * Test ElementAnalysisService with real images → LLM analyze as "object"
 *
 * Run: node test_element_analysis.mjs
 */

import "dotenv/config";
import { LLMService } from "./src/core/LLMService.js";
import { ElementAnalysisService } from "./src/services/ElementAnalysisService.js";

// ── Test images (public URLs — no auth required) ──────────────────────────────
const TEST_IMAGES = [
  "https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=800", // classic watch
  "https://images.unsplash.com/photo-1585386959984-a4155224a1ad?w=800", // perfume bottle
];

async function main() {
  console.log("═══════════════════════════════════════════════════");
  console.log("   ElementAnalysisService — Real Image Test        ");
  console.log("═══════════════════════════════════════════════════\n");

  const analysisService = new ElementAnalysisService();

  // ── Test 1: Object with images ─────────────────────────────────────────────
  console.log("📦 [Test] Analyzing as element type: OBJECT");
  console.log(`   Images: ${TEST_IMAGES.length} reference(s)`);
  TEST_IMAGES.forEach((u, i) => console.log(`   [${i + 1}] ${u.slice(0, 70)}...`));
  console.log();

  try {
    const description = await analysisService.generateDescription({
      elementName: "Luxury Product",
      elementType: "object",
      references: TEST_IMAGES,
    });

    console.log("✅ SUCCESS!\n");
    console.log("📝 Generated Description:");
    console.log("─────────────────────────────────────────────────────");
    console.log(description);
    console.log("─────────────────────────────────────────────────────\n");
  } catch (err) {
    console.error("❌ FAILED:", err.message);
  }

  // ── Test 2: Object WITHOUT images (text only fallback) ────────────────────
  console.log("📦 [Test] Analyzing as element type: OBJECT (no references)");
  try {
    const description = await analysisService.generateDescription({
      elementName: "Vintage Leather Briefcase",
      elementType: "object",
      references: [],
    });

    console.log("✅ SUCCESS!\n");
    console.log("📝 Generated Description (text-only):");
    console.log("─────────────────────────────────────────────────────");
    console.log(description);
    console.log("─────────────────────────────────────────────────────\n");
  } catch (err) {
    console.error("❌ FAILED:", err.message);
  }

  console.log("═══════════════════════════════════════════════════");
  console.log("   Tests Complete");
  console.log("═══════════════════════════════════════════════════\n");
}

main().catch(console.error);
