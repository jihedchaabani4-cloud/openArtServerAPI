async function test() {
  console.log("Sending POST request to http://localhost:5000/api/images/generated...");
  
  const response = await fetch("http://localhost:5000/api/images/generated", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer dummy-token"
    },
    body: JSON.stringify({
      prompt: "cat in paris",
      model_name: "nanobana_pro",
      project_id: "7840df10-9cce-43c4-85a0-6b885ca5f1e1",
      session_id: "dummy-session-id"
    })
  });

  console.log("Status:", response.status);
  const json = await response.json();
  console.log("Response JSON:", JSON.stringify(json, null, 2));
}

test();
