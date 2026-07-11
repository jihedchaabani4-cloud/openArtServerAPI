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

print("\n=== TEST 1: simple-image-v1 WITH user model ===")
resp = session.post(f"{BASE}/v2/workflows/run", json={
    "workflow_id": "simple-image-v1",
    "input": {
        "prompt": "A cat in space",
        "style": "digital art",
        "model": "dall-e-3"
    }
}, headers={"x-trace-id": "test1"}, timeout=30)
print("STATUS:", resp.status_code, "BODY:", resp.text[:300])

print("\n=== TEST 2: simple-image-v1 WITHOUT model ===")
resp2 = session.post(f"{BASE}/v2/workflows/run", json={
    "workflow_id": "simple-image-v1",
    "input": {
        "prompt": "A dog on mars"
    }
}, headers={"x-trace-id": "test2"}, timeout=30)
print("STATUS:", resp2.status_code, "BODY:", resp2.text[:300])

print("\n=== TEST 3: character-sheet-v1 (server default model) ===")
resp3 = session.post(f"{BASE}/v2/workflows/run", json={
    "workflow_id": "character-sheet-v1",
    "input": {
        "prompt": "A knight"
    }
}, headers={"x-trace-id": "test3"}, timeout=30)
print("STATUS:", resp3.status_code, "BODY:", resp3.text[:300])

print("\n=== TEST 4: character-sheet-v1 WITH user model (should REJECT) ===")
resp4 = session.post(f"{BASE}/v2/workflows/run", json={
    "workflow_id": "character-sheet-v1",
    "input": {
        "prompt": "A wizard",
        "model": "gpt-4"
    }
}, headers={"x-trace-id": "test4"}, timeout=30)
print("STATUS:", resp4.status_code, "BODY:", resp4.text[:500])

print("\n=== TEST 5: simple-image-v1 with unknown field (should REJECT) ===")
resp5 = session.post(f"{BASE}/v2/workflows/run", json={
    "workflow_id": "simple-image-v1",
    "input": {
        "prompt": "A bird",
        "unknown_field": "bad"
    }
}, headers={"x-trace-id": "test5"}, timeout=30)
print("STATUS:", resp5.status_code, "BODY:", resp5.text[:500])

print("\n=== DONE ===")
