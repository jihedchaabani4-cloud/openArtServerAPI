import "dotenv/config";

async function test() {
  const apiKey = process.env.REPLICATE_API_KEY;
  console.log("Submitting prediction to Replicate...");
  
  // Submit a real image generation to Replicate using SDXL
  const response = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      "Authorization": `Token ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      version: "7762fd07cf82c948538e41f63f77d685e02b063e37e496e96eefd46c929f9bdc",
      input: {
        prompt: "a beautiful cinematic rendering of a cute orange kitten sitting on a desk next to a glowing keyboard",
        width: 1024,
        height: 1024
      }
    })
  });

  console.log("Submit Status:", response.status);
  let prediction = await response.json();
  const predictionId = prediction.id;
  console.log("Prediction ID:", predictionId);

  // Poll for completion
  console.log("Polling for result...");
  while (prediction.status !== "succeeded" && prediction.status !== "failed" && prediction.status !== "canceled") {
    await new Promise(r => setTimeout(r, 2000));
    const pollRes = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      headers: { "Authorization": `Token ${apiKey}` }
    });
    prediction = await pollRes.json();
    console.log("Status:", prediction.status);
  }

  console.log("Final Output:", prediction.output);
}

test();
