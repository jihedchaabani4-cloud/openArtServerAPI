import "dotenv/config";

async function test() {
  const apiKey = process.env.GOOGLE_AI_STUDIO_API_KEY;
  console.log("Testing with GOOGLE_AI_STUDIO_API_KEY:", apiKey);
  
  const modelName = "gemini-2.0-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;

  const body = {
      contents: [
          {
              role: "user",
              parts: [{ text: "a cat in Paris" }]
          }
      ]
  };

  const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
  });

  console.log("Status:", response.status);
  const text = await response.text();
  console.log("Response:", text.substring(0, 1000));
}

test();
