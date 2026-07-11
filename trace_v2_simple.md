# V2 TRACE - Kifeh ye5dem bdhabt

## Mele: User yab3ath request

```
POST /api/v2/workflows/run
{
  "workflow_id": "character-sheet-v1",
  "input": {
    "prompt": "A cyberpunk hacker",
    "style": "anime"
  }
}
```

## Mar7el 1: Controller (50ms)

```
1. Auth: JWT valid? → user_id = "user_123"

2. Charge workflow YAML:
   src/v2/registry/workflows/character-sheet-v1.yaml
   
   content:
   id: character-sheet-v1
   nodes:
     - build_prompt (prompt-builder)
     - generate (image-generation)  ← depends_on: [build_prompt]
   
3. Valide input:
   ✓ prompt existe? OUI
   ✓ style existe? OUI (optionnel)
   ✓ champ inconnu? NON
   
4. Compile workflow → ExecutionGraph:
   {
     nodes: [
       { id: "build_prompt", type: "prompt-builder", tier: 1 },
       { id: "generate", type: "image-generation", tier: 2, depends_on: ["build_prompt"] }
     ],
     edges: ["build_prompt" → "generate"],
     outputs: {
       main_asset: "${generate.output.assets}"
     }
   }

5. CRÉE run dans DB:
   
   SQL: INSERT INTO v2_workflow_runs (...)
   
   run_id: "run_abc123"
   workflow_id: "character-sheet-v1"
   status: "pending"
   input: { prompt: "A cyberpunk hacker", style: "anime" }
   execution_plan: { nodes: [...], edges: [...] }
   
   SQL: INSERT INTO v2_workflow_run_nodes (...)
   
   (run_abc123, build_prompt, prompt-builder, pending, 1)
   (run_abc123, generate, image-generation, pending, 1)

6. Enqueue job BullMQ
   queue: "v2-workflow-jobs"
   data: { runId: "run_abc123" }

7. Response: { run_id: "run_abc123", status: "pending" }
```

## Mar7el 2: Worker démarre (5ms)

```
Worker (v2WorkflowWorker.js) déjà running

bootstrapV2() déjà appelé au startup:
  - initializeGateways(billing, storage, events)
  - registerProviders(fal, runway, topaz)

Worker reçoit job: { name: "workflow-run", data: { runId: "run_abc123" } }
```

## Mar7el 3: Orchestrateur (10ms setup)

```
executeOrchestration("run_abc123")

1. Charge run depuis DB:
   SELECT * FROM v2_workflow_runs WHERE run_id = "run_abc123"
   → { status: "pending", execution_plan: {...} }

2. Parse execution_plan → ExecutionGraph

3. Détecte tiers:
   Tier 1: [build_prompt]     ← pas de depends_on
   Tier 2: [generate]         ← depends_on: [build_prompt]

4. Enqueue tier 1:
   BullMQ: { name: "node-execute", data: { runId, nodeId: "build_prompt" } }

SQL: UPDATE v2_workflow_run_nodes SET status = "running" WHERE node_id = "build_prompt"
```

## Mar7el 4: Node build_prompt (100ms)

```
executeNode("prompt-builder", resolvedInputs, ctx)

1. Résout inputs:
   prompt = "A cyberpunk hacker"
   style = "anime"
   characters = undefined → []
   references = undefined → []

2. Charge skill (si workflow a config.skills):
   skill = "character-sheet"
   pipeline: ["extract_dna", "build_views", "add_style"]

3. Exécute pipeline:
   - extract_dna: pas de DNA → skip
   - build_views: génère 4 descriptions (front, side, back, detail)
   - add_style: ajoute "anime style"

4. Render finalPrompt:
   "A cyberpunk hacker, front view, spiky hair, tech jacket, anime style"

OUTPUT:
{
  finalPrompt: "A cyberpunk hacker...",
  context: {
    prompt: "A cyberpunk hacker",
    style: "anime",
    views: { front: "...", side: "..." },
    skill: { id: "character-sheet" }
  }
}

SQL: UPDATE v2_workflow_run_nodes 
     SET status = "completed", output = '{"finalPrompt":"..."}'
     WHERE run_id = "run_abc123" AND node_id = "build_prompt"
```

## Mar7el 5: Orchestrateur (encore, 5ms)

```
1. Vérifie si tier 2 prêt:
   generate dépend de build_prompt → build_prompt completed ✓

2. Enqueue tier 2:
   BullMQ: { name: "node-execute", data: { runId, nodeId: "generate" } }

SQL: UPDATE v2_workflow_run_nodes SET status = "running" WHERE node_id = "generate"
```

## Mar7el 6: Node generate (5-30s)

```
executeNode("image-generation", resolvedInputs, ctx)

1. Résout inputs (bindings):
   prompt = "${build_prompt.output.finalPrompt}"
     → "A cyberpunk hacker, front view..."
   
   width = 1024 (config)
   height = 1024 (config)
   count = 4 (config)

2. RESERVE BILLING (1 crédit):
   SQL: INSERT INTO transactions (wallet_id, amount, type, status, reference_id)
        VALUES ("wallet_123", 1, "DEBIT", "PENDING", "v2:run_abc123:generate:1")

3. SELECT PROVIDER:
   selectProvider("image-generation", { modelHint: null })
   → "fal" (le seul enregistré)

4. GET ADAPTER:
   adapter = registries.adapters["fal"]

5. EXECUTE ADAPTER:
   adapter.execute({
     capabilityId: "IMAGE_GENERATION",
     prompt: "A cyberpunk hacker, front view...",
     width: 1024,
     height: 1024,
     count: 4,
     model: null
   })

   → En beta: MOCK (pas de vrai provider)
   → Retourne 4 images:
   [
     { id: "fal-1", url: "https://placehold.co/1024x1024.png", metadata: {...} },
     { id: "fal-2", url: "https://placehold.co/1024x1024.png", metadata: {...} },
     { id: "fal-3", url: "https://placehold.co/1024x1024.png", metadata: {...} },
     { id: "fal-4", url: "https://placehold.co/1024x1024.png", metadata: {...} }
   ]

6. BUILD OUTPUT:
   {
     assets: [...4 images...],
     metadata: { provider: "fal", latencyMs: 800 }
   }

7. PERSIST MEDIA (NOUVEAU Bridge V1!):
   persistNodeMediaOutputs({ runId, nodeId, output, run, input })
   
   Pour chaque asset:
   → storageGateway.persistMediaResult(asset + _v2Context)
   → V1StorageBridge.persistV2Output({...})
   
   CRÉE EN V1:
   - Project "V2 Works"
   - Workflow "character-sheet-v1 - abc123"
   - Config (prompt, model "chatgpt-2")
   - 4 Media (vrais assets en DB!)
   
   Asset enrichi:
   {
     ...asset,
     status: "stored",
     v1WorkflowId: "wf_v1_xyz",
     v1MediaId: "med_v1_001"
   }

8. SETTLE BILLING:
   SQL: UPDATE transactions SET status = "COMPLETED" 
        WHERE reference_id = "v2:run_abc123:generate:1"

OUTPUT:
{
  assets: [4 images avec v1MediaId],
  metadata: { provider: "fal", latencyMs: 800 }
}

SQL: UPDATE v2_workflow_run_nodes 
     SET status = "completed", output = '{"assets":[...]}'
     WHERE run_id = "run_abc123" AND node_id = "generate"
```

## Mar7el 7: Orchestrateur - Final (10ms)

```
1. Tous les nodes completed? OUI

2. Résout outputs:
   main_asset = "${generate.output.assets}"
     → nodeRun.output.assets
     → [4 images]

3. UPDATE RUN:
   SQL: UPDATE v2_workflow_runs
        SET status = "completed",
            outputs = '{"main_asset":[4 images]}',
            completed_at = NOW()
        WHERE run_id = "run_abc123"

4. Log event:
   eventRecorder.record({ operation: "workflow.complete", status: "success" })
```

## Mar7el 8: User reçoit résultat (polling)

```
GET /api/v2/workflows/runs/run_abc123

Response:
{
  "run_id": "run_abc123",
  "workflow_id": "character-sheet-v1",
  "status": "completed",
  "nodes": {
    "build_prompt": { "status": "completed", "attempt": 1 },
    "generate": { "status": "completed", "attempt": 1 }
  },
  "outputs": {
    "main_asset": [
      { "url": "https://...", "metadata": { "provider": "fal", "v1MediaId": "med_v1_001" } },
      { "url": "https://...", "metadata": { "provider": "fal", "v1MediaId": "med_v1_002" } },
      { "url": "https://...", "metadata": { "provider": "fal", "v1MediaId": "med_v1_003" } },
      { "url": "https://...", "metadata": { "provider": "fal", "v1MediaId": "med_v1_004" } }
    ]
  }
}
```

## DB Après le run

### V2 Tables
```
v2_workflow_runs:
  run_id: "run_abc123"
  workflow_id: "character-sheet-v1"
  status: "completed"
  input: { prompt: "A cyberpunk hacker", style: "anime" }
  outputs: { main_asset: [4 images] }
  execution_plan: { nodes: [...], edges: [...] }

v2_workflow_run_nodes:
  (run_abc123, build_prompt, prompt-builder, completed, 1, { finalPrompt: "..." })
  (run_abc123, generate, image-generation, completed, 1, { assets: [...] })
```

### V1 Tables (créées par Bridge)
```
project:
  id: "proj_v2_001", name: "V2 Works", user_id: "user_123"

workflow:
  id: "wf_v1_xyz", project_id: "proj_v2_001", display_name: "character-sheet-v1 - abc123"
  primary_media_id: "med_v1_001"

generation_config:
  id: "cfg_v1_abc", prompt: "A cyberpunk hacker...", model: "chatgpt-2"

media (4 lignes):
  id: "med_v1_001", workflow_id: "wf_v1_xyz", step_id: "GEN", url: "https://..."
  id: "med_v1_002", workflow_id: "wf_v1_xyz", step_id: "GEN", url: "https://..."
  id: "med_v1_003", workflow_id: "wf_v1_xyz", step_id: "GEN", url: "https://..."
  id: "med_v1_004", workflow_id: "wf_v1_xyz", step_id: "GEN", url: "https://..."

transactions (billing):
  wallet_id: "wallet_123", amount: 1, type: "DEBIT", status: "COMPLETED"
  reference_id: "v2:run_abc123:generate:1"
```

## Résumé V2 en chiffres

| Étape | Quoi | Durée |
|-------|------|-------|
| 1 | Controller (auth, validation, création run) | ~50ms |
| 2-3 | Worker + Orchestrateur (setup) | ~15ms |
| 4 | Node build_prompt | ~100ms |
| 5 | Orchestrateur (enqueue next) | ~5ms |
| 6 | Node generate (provider + billing + persist) | ~5-30s |
| 7 | Finalisation | ~10ms |
| 8 | Response au client | instant |
| **Total** | | **~5-30s** |

## Différence clé: V1 vs V2

```
V1: Treatment = TOUT en UNE classe
    ┌─────────────────────────┐
    │ GenerateImageTreatment  │
    │ ├─ prepare()            │
    │ ├─ run()                │
    │ ├─ upload()             │
    │ └─ updateDB()           │
    └─────────────────────────┘

V2: Séparé en NODES réutilisables
    ┌──────────┐    ┌──────────────┐
    │prompt-   │───►│image-        │
    │builder   │    │generation    │
    └──────────┘    └──────────────┘
         │                │
         │           ┌────┴────┐
         │           │ Billing │
         │           │ (1 cr)  │
         │           └────┬────┘
         │                │
         │           ┌────┴────┐
         │           │ Bridge  │
         │           │ V2 → V1 │
         │           └────┬────┘
         │                │
         │           ┌────┴────┐
         │           │  V1 DB  │
         │           │workflow │
         │           │ + media │
         │           └─────────┘
```

## En deux mots

> **V2 = "Moteur qui exécute des graphes YAML"**
> 
> Chaque node fait SA spécialité:
> - prompt-builder: optimise les prompts
> - image-generation: appelle les providers
> - media-transform: transforme des images existantes
> 
> L'orchestrateur coordonne, le bridge persiste en V1.
