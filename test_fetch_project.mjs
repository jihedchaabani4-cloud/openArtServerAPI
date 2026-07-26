async function testFetchProject() {
  const projectId = "3daf2196-2f09-46f4-a427-08875ea02ffe";

  console.log("📥 Fetching project-data to verify saved fields...");
  const res = await fetch(`http://localhost:5000/api/workflows/project-data/${projectId}`, {
    headers: {
      "x-internal-secret": "openart_internal_s2s_secret_2026",
    },
  });

  const data = await res.json();
  const rawWorkflows = data?.projectContents?.workflows || data?.workflows || [];
  console.log(`Found ${rawWorkflows.length} workflows in project`);

  if (rawWorkflows.length > 0) {
    const sample = rawWorkflows[0];
    console.log("✅ Sample workflow record from backend:");
    console.log({
      name: sample.name,
      description: sample.description,
      keywords: sample.keywords,
      guidelines: sample.guidelines,
    });
  }
}

testFetchProject().catch(console.error);
