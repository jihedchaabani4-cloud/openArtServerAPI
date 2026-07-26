/**
 * test_llm_service.mjs
 * Run with: node test_llm_service.mjs
 * Or with a custom key: GEMINI_API_KEY=AIzaSy... node test_llm_service.mjs
 */

import "dotenv/config";

// ── Inline LLMService (no import issues in standalone test) ──────────────────

async function testGeminiText(apiKey, model = "gemini-1.5-flash") {
  console.log(`\n🔵 [Test 1] Gemini Text — model: ${model}`);
  console.log(`   API Key starts with: ${apiKey?.slice(0, 10)}...`);

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              {
                text: 'Describe a cinematic film element called "Golden Hour Sunset" in 2 sentences. Be concise and professional.',
              },
            ],
          },
        ],
      }),
    }
  );

  if (res.ok) {
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    console.log(`   ✅ Gemini Text SUCCESS!`);
    console.log(`   📝 Response: ${text?.slice(0, 200)}`);
    return true;
  } else {
    const err = await res.json().catch(() => res.text());
    console.log(`   ❌ Gemini Text FAILED — Status: ${res.status}`);
    console.log(`   Error:`, JSON.stringify(err?.error || err, null, 2));
    return false;
  }
}

async function testGeminiModels(apiKey) {
  console.log(`\n🔍 [Test 0] Listing available Gemini models...`);
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
    { method: "GET" }
  );

  if (res.ok) {
    const data = await res.json();
    const models = (data.models || [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
      .map((m) => m.name.replace("models/", ""));

    console.log(`   ✅ Found ${models.length} models that support generateContent:`);
    models.forEach((m) => console.log(`      - ${m}`));
    return models;
  } else {
    const err = await res.json().catch(() => res.text());
    console.log(`   ❌ Could not list models — Status: ${res.status}`);
    console.log(`   Error:`, JSON.stringify(err?.error || err, null, 2));
    return [];
  }
}

async function testGroqFallback(apiKey) {
  console.log(`\n🟣 [Test 2] Groq Text Fallback — model: llama-3.3-70b-versatile`);
  console.log(`   API Key starts with: ${apiKey?.slice(0, 10)}...`);

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        {
          role: "user",
          content:
            'Describe a cinematic film element called "Golden Hour Sunset" in 2 sentences. Be concise and professional.',
        },
      ],
      temperature: 0.7,
      max_tokens: 200,
    }),
  });

  if (res.ok) {
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    console.log(`   ✅ Groq Text SUCCESS!`);
    console.log(`   📝 Response: ${text?.slice(0, 200)}`);
    return true;
  } else {
    const err = await res.json().catch(() => res.text());
    console.log(`   ❌ Groq Text FAILED — Status: ${res.status}`);
    console.log(`   Error:`, JSON.stringify(err?.error || err, null, 2));
    return false;
  }
}

// ── Run Tests ─────────────────────────────────────────────────────────────────

async function main() {
  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  const GROQ_KEY   = process.env.GROQ_API_KEY;

  console.log("═══════════════════════════════════════════");
  console.log("   LLMService — API Key Validation Tests   ");
  console.log("═══════════════════════════════════════════");

  if (!GEMINI_KEY) {
    console.log("\n⚠️  GEMINI_API_KEY not found in .env");
  } else {
    // First list available models
    const models = await testGeminiModels(GEMINI_KEY);

    // Test gemini-flash-latest (from our available list)
    await testGeminiText(GEMINI_KEY, "gemini-flash-latest");

    // Test gemini-2.0-flash-lite (free tier)
    await testGeminiText(GEMINI_KEY, "gemini-2.0-flash-lite");

    // Test gemini-3.1-flash-lite (latest free)
    await testGeminiText(GEMINI_KEY, "gemini-3.1-flash-lite");
  }

  if (!GROQ_KEY) {
    console.log("\n⚠️  GROQ_API_KEY not found in .env");
  } else {
    await testGroqFallback(GROQ_KEY);
  }

  console.log("\n═══════════════════════════════════════════");
  console.log("   Tests Complete");
  console.log("═══════════════════════════════════════════\n");
}

main().catch(console.error);
