import json
import time
import requests

BASE = "http://localhost:5000/api"
email = "openart.trae.test+028b454b@gmail.com"
password = "TraeTest123!"

session = requests.Session()

# Login
login_resp = session.post(
    f"{BASE}/auth/login",
    json={"email": email, "password": password},
    timeout=30,
)
print("LOGIN", login_resp.status_code)
login_resp.raise_for_status()

print("\n=== TEST: edit-image-v1 workflow ===")
resp = session.post(f"{BASE}/v2/workflows/run", json={
    "workflow_id": "edit-image-v1",
    "input": {
        "prompt": "remove background",
        "source_asset": {
            "id": "asset_123",
            "url": "https://placehold.co/1024x1024.png",
            "type": "image",
            "width": 1024,
            "height": 1024,
            "description": "a fluffy orange cat sitting on a couch"
        },
        "style": "clean white background",
        "model": "flux-kontext"
    }
}, headers={"x-trace-id": "edit-test"}, timeout=30)

print("STATUS:", resp.status_code)
if resp.status_code == 202:
    data = resp.json()
    print("RUN_ID:", data.get("run_id"))
    print("STATUS:", data.get("status"))
    
    run_id = data["run_id"]
    
    # Poll for completion
    for i in range(30):
        status_resp = session.get(
            f"{BASE}/v2/workflows/runs/{run_id}",
            headers={"x-trace-id": "edit-poll"},
            timeout=30,
        )
        status_data = status_resp.json()
        status = status_data.get("status")
        nodes = status_data.get("nodes", {})
        
        bp = nodes.get("build_prompt", {})
        tr = nodes.get("transform", {})
        print(f"  Poll {i+1}: status={status}, build_prompt={bp.get('status','?')}, transform={tr.get('status','?')}")
        
        if status in ("completed", "failed"):
            print("\n=== FINAL RESULT ===")
            print(json.dumps(status_data, indent=2))
            break
        time.sleep(2)
else:
    print("ERROR:", resp.text[:500])

print("\n=== DONE ===")
