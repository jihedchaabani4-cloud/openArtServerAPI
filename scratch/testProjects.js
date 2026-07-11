/**
 * Test: verify what user ID is being used by the auth middleware
 * and what projects are returned
 */
async function test() {
  console.log("=== Testing /api/projects (no token) ===");
  
  // Test 1: No token - should return 401
  try {
    const res1 = await fetch("http://localhost:5000/api/projects", {
      method: "GET",
      headers: { "Content-Type": "application/json" }
    });
    console.log("No token → Status:", res1.status);
    const body1 = await res1.json();
    console.log("Response:", JSON.stringify(body1).substring(0, 200));
  } catch (e) {
    console.error("Error:", e.message);
  }

  console.log("\n=== Testing /api/auth/me (no token) ===");
  
  // Test 2: Check /api/auth/me
  try {
    const res2 = await fetch("http://localhost:5000/api/auth/me", {
      method: "GET",
      headers: { "Content-Type": "application/json" }
    });
    console.log("No token → Status:", res2.status);
    const body2 = await res2.json();
    console.log("Response:", JSON.stringify(body2).substring(0, 200));
  } catch (e) {
    console.error("Error:", e.message);
  }

  console.log("\n=== Checking DEV_AUTH_BYPASS env value ===");
  // Test 3: Check bypass status via a special debug endpoint
  try {
    const res3 = await fetch("http://localhost:5000/api/projects", {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer FAKE_TOKEN_12345"
      }
    });
    console.log("Fake token → Status:", res3.status);
    const body3 = await res3.json();
    // If bypass is ON, it will return 200 with projects
    // If bypass is OFF, it will return 401
    if (res3.status === 200) {
      console.log("⚠️  DEV_AUTH_BYPASS still ACTIVE! Projects returned:", (body3.data || []).length);
      console.log("First project:", JSON.stringify(body3.data?.[0]).substring(0, 100));
    } else {
      console.log("✅ DEV_AUTH_BYPASS is OFF - fake token rejected correctly");
      console.log("Error:", body3.message);
    }
  } catch (e) {
    console.error("Error:", e.message);
  }
}

test();
