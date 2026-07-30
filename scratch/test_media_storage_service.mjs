import "dotenv/config";
import { uploadMedia } from "../src/services/mediaStorageService.js";

async function testAnonymousUpload() {
  console.log("Testing with userId = 'anonymous'...");
  const sampleBase64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  
  try {
    const url = await uploadMedia(sampleBase64, {
      userId: "anonymous",
      projectId: "40f3810f-960c-4d2b-b1e1-6e6684ed936d",
      index: 0,
    });
    console.log("✅ Anonymous Upload URL:", url);
  } catch (err) {
    console.error("❌ Anonymous Upload failed:", err);
  }
}

testAnonymousUpload();
