import "dotenv/config";

async function test() {
  const apiKey = process.env.WAVESPEED_API_KEY;
  
  // Try a different, potentially cheaper model
  const modelName = "google/nano-banana/text-to-image";
  console.log(`Testing model: ${modelName} with WAVESPEED_API_KEY: ${apiKey}`);
  
  const response = await fetch(`https://api.wavespeed.ai/api/v3/${modelName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      prompt: "a cat in Paris",
      width: 512,
      height: 512
    })
  });
  
  console.log("Status:", response.status);
  const text = await response.text();
  console.log("Response:", text);
}

test();
