import json
import time
import requests

BASE = "http://localhost:5000/api"
email = "openart.trae.test+028b454b@gmail.com"
password = "TraeTest123!"

session = requests.Session()

login_resp = session.post(
    f"{BASE}/auth/login",
    json={"email": email, "password": password},
    timeout=30,
)
print("LOGIN", login_resp.status_code, login_resp.text[:200])
login_resp.raise_for_status()

payload = {
    "workflow_id": "simple-image-v1",
    "input": {
        "prompt": "A futuristic red car in Tokyo at night",
        "style": "cinematic neon lighting",
        "references": [],
        "characters": []
    }
}

run_resp = session.post(
    f"{BASE}/v2/workflows/run",
    json=payload,
    headers={"x-trace-id": "python-simple-image-run"},
    timeout=30,
)
print("RUN", run_resp.status_code, run_resp.text[:300])
run_resp.raise_for_status()
run_id = run_resp.json()["run_id"]
print("RUN_ID", run_id)

for i in range(30):
    status_resp = session.get(
        f"{BASE}/v2/workflows/runs/{run_id}",
        headers={"x-trace-id": "python-simple-image-poll"},
        timeout=30,
    )
    data = status_resp.json()
    status = data.get("status")
    nodes = data.get("nodes", {})
    build_status = nodes.get("build_prompt", {}).get("status", "?")
    gen_status = nodes.get("generate", {}).get("status", "?")
    print(f"POLL {i+1}: status={status}, build_prompt={build_status}, generate={gen_status}")
    
    if status in ("completed", "failed"):
        print("FINAL STATUS:", status)
        print("FINAL DATA:", json.dumps(data, indent=2))
        if status != "completed":
            raise SystemExit(1)
        break
    time.sleep(2)
else:
    raise SystemExit("Timed out waiting for workflow completion")
