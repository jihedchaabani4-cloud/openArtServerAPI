# ═══════════════════════════════════════════════════════════════════════════
# CHARACTER SHEET v1 - TAWEEL L'MAR7EL (Trace Complète)
# ═══════════════════════════════════════════════════════════════════════════
#
# Workflow: character-sheet-v1
# But: Générer un character sheet (4 vues: front, side, back, detail)
#
# ═══════════════════════════════════════════════════════════════════════════

# ┌─────────────────────────────────────────────────────────────────────────┐
# │ ÉTAPE 0: REQUEST DU USER                                                │
# └─────────────────────────────────────────────────────────────────────────┘

POST http://localhost:5000/api/v2/workflows/run
Content-Type: application/json
x-trace-id: character-sheet-007

{
  "workflow_id": "character-sheet-v1",
  "input": {
    "prompt": "A cyberpunk hacker character with neon tattoos",
    "characters": [{
      "name": "Zero",
      "dna": "hacker-dna-001"
    }],
    "references": [
      { "url": "https://.../ref1.jpg", "weight": 0.8 }
    ],
    "style": "anime style"
  }
}

# ┌─────────────────────────────────────────────────────────────────────────┐
# │ ÉTAPE 1: CONTROLLER (workflowsController.js)                            │
# │ Durée: ~50ms                                                            │
# └─────────────────────────────────────────────────────────────────────────┘

# 1a. Authentification
#     → Middleware requireAuth vérifie le JWT
#     → Récupère user_id: "932d4215-9cae-4abf-9def-6b82644aa459"

# 1b. Récupération du workflow YAML
#     → registries.workflows['character-sheet-v1']
#     → Fichier: src/v2/registry/workflows/character-sheet-v1.yaml

#     Contenu chargé:
#     {
#       id: "character-sheet-v1",
#       version: "1.0.0",
#       input_schema: {
#         required: ["prompt"],
#         properties: {
#           prompt: { type: "string" },
#           characters: { type: "array" },
#           references: { type: "array" },
#           style: { type: "string" }
#         }
#       },
#       default_model: "chatgpt-2",
#       nodes: [
#         {
#           id: "build_prompt",
#           type: "prompt-builder",
#           user_inputs: {
#             prompt: "${input.prompt}",
#             characters: "${input.characters}",
#             references: "${input.references}",
#             style: "${input.style}"
#           },
#           config: {
#             skills: ["character-sheet"],
#             skill_parameters: {
#               views: ["front", "side", "back"],
#               style: "realistic"
#             }
#           }
#         },
#         {
#           id: "generate",
#           type: "image-generation",
#           depends_on: ["build_prompt"],
#           inputs: {
#             prompt: "${build_prompt.output.finalPrompt}",
#             references: "${build_prompt.output.context.references}",
#             model: "${input.model}"   # ← null car pas dans input
#           },
#           config: {
#             width: 1024,
#             height: 1024,
#             count: 4,
#             model: "chatgpt-2"         # ← SERVER DEFAULT (input_schema n'a pas 'model')
#           }
#         }
#       ],
#       outputs: {
#         main_asset: "${generate.output.assets}",
#         model_used: "${generate.output.metadata.model}"
#       }
#     }

# 1c. Validation des inputs
#     → validateRunInput(input, workflow.input_schema)
#     ✓ prompt: string ✓
#     ✓ characters: array ✓
#     ✓ references: array ✓
#     ✓ style: string ✓
#     ✓ Aucun champ inconnu (sinon 400)

# 1d. Résolution du modèle
#     → resolveModelInput(input, workflow)
#     → workflow.default_model = "chatgpt-2"
#     → workflow.input_schema.properties.model = undefined
#     → Donc: input.model reste undefined
#     → MAIS node.generate.config.model = "chatgpt-2" (server-side)

# 1e. Compilation du workflow
#     → compileWorkflow(workflow, registries)
#     → Résolution des bindings:
#       "${input.prompt}" → binding statique (input.prompt)
#       "${build_prompt.output.finalPrompt}" → binding dynamique (node output)
#       "${input.model}" → binding statique (input.model = undefined)
#     → Vérification des dépendances:
#       build_prompt: tier 1 (pas de depends_on)
#       generate: tier 2 (depends_on: [build_prompt])
#     → Validation des skills:
#       skill "character-sheet" existe dans registries.skills
#       skill_parameters validés contre le schéma du skill

# 1f. Démarrage du run
#     → startWorkflowRun({ runId: generateUUID(), plan, runtimeInput })

#     SQL exécuté (v2_workflow_runs):
INSERT INTO v2_workflow_runs (
  run_id, workflow_id, workflow_version, user_id,
  status, input, execution_plan, created_at
) VALUES (
  'run_7a8f9e2b-...',           -- run_id
  'character-sheet-v1',         -- workflow_id
  '1.0.0',                      -- workflow_version
  '932d4215-...',               -- user_id
  'pending',                    -- status
  '{"prompt":"A cyberpunk...",  -- input (JSON)
    "characters":[...],
    "references":[...],
    "style":"anime style"}',
  '{"nodes":[{"id":"build_prompt",...  -- execution_plan (JSON)
    "edges":[...],
    "outputs":{...}}',
  NOW()                         -- created_at
);

#     SQL exécuté (v2_workflow_run_nodes):
INSERT INTO v2_workflow_run_nodes (run_id, node_id, node_type, status, attempt)
VALUES
  ('run_7a8f9e2b-...', 'build_prompt', 'prompt-builder', 'pending', 1),
  ('run_7a8f9e2b-...', 'generate', 'image-generation', 'pending', 1);

#     Response au client:
HTTP/1.1 202 Accepted
{
  "run_id": "run_7a8f9e2b-...",
  "status": "pending",
  "workflow_id": "character-sheet-v1"
}

# ┌─────────────────────────────────────────────────────────────────────────┐
# │ ÉTAPE 2: QUEUE (BullMQ)                                                 │
# │ Durée: ~10ms                                                            │
# └─────────────────────────────────────────────────────────────────────────┘

#     → v2WorkflowQueueGateway.enqueue('workflow-run', { runId: 'run_7a8f9e2b-...' })
#     → BullMQ ajoute le job dans la queue "v2-workflow-jobs"
#     → Job ID: job_123

# ┌─────────────────────────────────────────────────────────────────────────┐
# │ ÉTAPE 3: WORKER (v2WorkflowWorker.js)                                   │
# │ Durée: ~5ms (startup)                                                   │
# └─────────────────────────────────────────────────────────────────────────┘

#     → Worker démarre (déjà running)
#     → bootstrapV2() a déjà été appelé au startup
#     → Registries chargés: nodes, skills, providers, adapters

#     → Worker reçoit le job:
#     { name: 'workflow-run', data: { runId: 'run_7a8f9e2b-...' } }

# ┌─────────────────────────────────────────────────────────────────────────┐
# │ ÉTAPE 4: ORCHESTRATEUR (workflowRunner.js)                              │
# │ Durée: variable (~5-30s total)                                          │
# └─────────────────────────────────────────────────────────────────────────┘

#     → processV2WorkflowJob({ runId: 'run_7a8f9e2b-...' })
#     → Récupère le run: SELECT * FROM v2_workflow_runs WHERE run_id = '...'

#     → executeOrchestration(runId)
#       ├─► Charge l'ExecutionGraph depuis execution_plan (JSON)
#       ├─► Détecte les tiers:
#           Tier 1: build_prompt (pas de dépendances)
#           Tier 2: generate (dépend de build_prompt)
#       ├─► Enqueue tier 1:

#     SQL:
UPDATE v2_workflow_runs SET status = 'running' WHERE run_id = '...';
UPDATE v2_workflow_run_nodes SET status = 'pending' WHERE run_id = '...' AND node_id = 'build_prompt';

#     → BullMQ job pour build_prompt:
#       { name: 'node-execute', data: { runId, nodeId: 'build_prompt' } }

# ┌─────────────────────────────────────────────────────────────────────────┐
# │ ÉTAPE 5: NODE build_prompt (promptBuilderNode.js)                       │
# │ Durée: ~50-200ms                                                        │
# └─────────────────────────────────────────────────────────────────────────┘

#     → executeNode('prompt-builder', resolvedInputs, ctx)

#     Inputs résolus:
#     {
#       prompt: "A cyberpunk hacker character with neon tattoos",
#       characters: [{ name: "Zero", dna: "hacker-dna-001" }],
#       references: [{ url: "...", weight: 0.8 }],
#       style: "anime style",
#       skill: {
#         id: "character-sheet",
#         version: "1.0",
#         pipeline: ["extract_dna", "build_views", "add_style"],
#         parameters: { views: ["front", "side", "back"], style: "realistic" }
#       }
#     }

#     Prompt Builder exécute:
#     1. Parameter Resolver
#        → Crée le WorkflowContext initial
#
#     2. Skill Engine
#        → Charge le skill "character-sheet"
#        → Pipeline: ["extract_dna", "build_views", "add_style"]
#
#     3. Processor Engine (exemple)
#        → extract_dna: Récupère les traits du DNA
#          "hacker-dna-001" → { hair: "spiky purple", outfit: "tech-jacket", ... }
#
#        → build_views: Construit les descriptions par vue
#          front: "A cyberpunk hacker facing forward, spiky purple hair, tech-jacket, neon tattoos on arms"
#          side: "A cyberpunk hacker side profile, spiky purple hair, tech-jacket"
#          back: "A cyberpunk hacker from behind, tech-jacket with circuit patterns"
#
#        → add_style: Ajoute le style
#          "... anime style, clean lines, vibrant colors"
#
#     4. Prompt Renderer
#        → finalPrompt: "A cyberpunk hacker character with neon tattoos, 
#                       front view, spiky purple hair, tech-jacket, 
#                       neon tattoos on arms, anime style, clean lines, vibrant colors"

#     Output:
#     {
#       finalPrompt: "A cyberpunk hacker character... (prompt complet)",
#       context: {
#         prompt: "A cyberpunk hacker character with neon tattoos",
#         characters: [...],
#         references: [...],
#         style: "anime style",
#         skill: { id: "character-sheet" },
#         views: { front: "...", side: "...", back: "..." }
#       }
#     }

#     SQL (update node):
UPDATE v2_workflow_run_nodes
SET status = 'completed',
    output = '{"finalPrompt":"A cyberpunk hacker...","context":{...}}',
    completed_at = NOW()
WHERE run_id = 'run_7a8f9e2b-...' AND node_id = 'build_prompt';

# ┌─────────────────────────────────────────────────────────────────────────┐
# │ ÉTAPE 6: ORCHESTRATEUR - Suite                                          │
# │ Durée: ~5ms                                                             │
# └─────────────────────────────────────────────────────────────────────────┘

#     → Tier 1 complété (build_prompt)
#     → Vérifie Tier 2: generate
#       ✓ Dépendance build_prompt satisfaite
#     → Enqueue node generate:

UPDATE v2_workflow_run_nodes SET status = 'pending' WHERE node_id = 'generate';

#     → BullMQ job pour generate:
#       { name: 'node-execute', data: { runId, nodeId: 'generate' } }

# ┌─────────────────────────────────────────────────────────────────────────┐
# │ ÉTAPE 7: NODE generate (imageGenerationNode.js)                         │
# │ Durée: ~5-30s (appel provider)                                          │
# └─────────────────────────────────────────────────────────────────────────┘

#     → executeNode('image-generation', resolvedInputs, ctx)

#     Inputs résolus (bindings):
#     {
#       prompt: "${build_prompt.output.finalPrompt}"
#         → "A cyberpunk hacker character... (prompt complet)"
#
#       references: "${build_prompt.output.context.references}"
#         → [{ url: "...", weight: 0.8 }]
#
#       width: 1024 (config)
#       height: 1024 (config)
#       count: 4 (config)
#       model: null (input.model absent)
#     }

#     Image Generation exécute:
#     1. Récupère l'adapter (fal)
#     2. RESERVE BILLING:
#        → billingGateway.reserve({
#            userId: "932d4215-...",
#            amount: 1,
#            referenceId: "v2:run_7a8f9e2b-...:generate:1"
#          })
#        → SQL: INSERT INTO transactions (wallet_id, amount, type, status, reference_id)
#               VALUES ('wallet_xxx', 1, 'DEBIT', 'PENDING', 'v2:run_...:generate:1')
#
#     3. SELECT PROVIDER:
#        → selectProvider('image-generation', { modelHint: null })
#        → Retourne "fal" (le seul provider)
#
#     4. BUILD PAYLOAD:
#        {
#          capabilityId: "IMAGE_GENERATION",
#          prompt: "A cyberpunk hacker character...",
#          width: 1024,
#          height: 1024,
#          count: 4,
#          model: null
#        }
#
#     5. EXECUTE ADAPTER:
#        → adapter.execute(payload)
#        → Appelle provider "fal"
#        → En V2 beta: retourne MOCK (pas de vrai provider)
#
#     Mock retourne:
#     {
#       providerId: "fal",
#       outputs: [
#         {
#           id: "fal-img-1234567890",
#           type: "image",
#           url: "https://placehold.co/1024x1024.png",
#           width: 1024,
#           height: 1024,
#           metadata: {
#             prompt: "A cyberpunk hacker character...",
#             provider: "fal",
#             model: null
#           }
#         },
#         { id: "fal-img-1234567891", ... },  # count=4 → 4 images
#         { id: "fal-img-1234567892", ... },
#         { id: "fal-img-1234567893", ... }
#       ]
#     }

#     6. BUILD OUTPUT:
#        assets = outputs.map(...)
#        metadata = { provider: "fal", decision: {...}, latencyMs: 800 }
#
#     7. SETTLE BILLING:
#        → billingGateway.settle("v2:run_7a8f9e2b-...:generate:1")
#        → SQL: UPDATE transactions SET status = 'COMPLETED' WHERE reference_id = '...'

#     Output:
#     {
#       assets: [ { id, url, type, width, height, metadata }, ... ],  # 4 images
#       metadata: { provider: "fal", latencyMs: 800 }
#     }

#     SQL (update node):
UPDATE v2_workflow_run_nodes
SET status = 'completed',
    output = '{"assets":[...],"metadata":{...}}',
    completed_at = NOW()
WHERE run_id = 'run_7a8f9e2b-...' AND node_id = 'generate';

# ┌─────────────────────────────────────────────────────────────────────────┐
# │ ÉTAPE 8: PERSISTENCE (Nouveau Bridge V1)                                │
# │ Durée: ~100-300ms                                                       │
# └─────────────────────────────────────────────────────────────────────────┘

#     → persistNodeMediaOutputs() appelé après executeNode()

#     8a. Normalization:
#         normalizeNodeMediaOutputs('image-generation', output)
#         → [ { ...asset1, runId, nodeId, type: "image" }, ... ]

#     8b. Pour chaque asset, appel storageGateway.persistMediaResult()

#         → WorkflowStorageGateway reçoit l'asset avec _v2Context:
#         {
#           ...asset,
#           _v2Context: {
#             runId: "run_7a8f9e2b-...",
#             workflowId: "character-sheet-v1",
#             userId: "932d4215-...",
#             output: { assets: [...], metadata: {...} },
#             nodeType: "image-generation",
#             input: { prompt: "...", style: "..." }
#           }
#         }

#     8c. V1StorageBridge.persistV2Output() est appelé:

#         ── Cherche/Crée Projet "V2 Works" ──
#         SELECT id FROM project WHERE user_id = '932d4215-...' AND project_name = 'V2 Works';
#         → Si existe pas:
#         INSERT INTO project (project_name, user_id) VALUES ('V2 Works', '932d4215-...');
#         → project_id: 'proj_v2_abc123'

#         ── Crée Workflow V1 ──
#         INSERT INTO workflow (
#           project_id, display_name, workflow_type, create_time
#         ) VALUES (
#           'proj_v2_abc123',
#           'character-sheet-v1 - 7a8f9e2b',
#           'GENERATION',
#           NOW()
#         );
#         → workflow_id: 'wf_v2_def456'

#         ── Crée Generation Config ──
#         INSERT INTO generation_config (
#           prompt, model, aspect_ratio, generation_type
#         ) VALUES (
#           'A cyberpunk hacker character...',
#           'chatgpt-2',
#           'SQUARE',
#           'TEXT_ONLY'
#         );
#         → config_id: 'cfg_v2_ghi789'

#         ── Crée Media V1 (pour chaque asset) ──
#         INSERT INTO media (
#           workflow_id, project_id, generation_config_id, step_id,
#           url, width, height, status, create_time
#         ) VALUES
#           ('wf_v2_def456', 'proj_v2_abc123', 'cfg_v2_ghi789', 'GEN',
#            'https://placehold.co/1024x1024.png', 1024, 1024, 'success', NOW()),
#           ('wf_v2_def456', 'proj_v2_abc123', 'cfg_v2_ghi789', 'GEN',
#            'https://placehold.co/1024x1024.png', 1024, 1024, 'success', NOW()),
#           ('wf_v2_def456', 'proj_v2_abc123', 'cfg_v2_ghi789', 'GEN',
#            'https://placehold.co/1024x1024.png', 1024, 1024, 'success', NOW()),
#           ('wf_v2_def456', 'proj_v2_abc123', 'cfg_v2_ghi789', 'GEN',
#            'https://placehold.co/1024x1024.png', 1024, 1024, 'success', NOW());
#         → media_ids: ['med_v2_001', 'med_v2_002', 'med_v2_003', 'med_v2_004']

#         ── Update Workflow Primary Media ──
#         UPDATE workflow SET primary_media_id = 'med_v2_001' WHERE id = 'wf_v2_def456';

#     8d. Retourne l'asset enrichi:
#         {
#           ...asset,
#           status: "stored",
#           v1WorkflowId: "wf_v2_def456",
#           v1MediaId: "med_v2_001"
#         }

# ┌─────────────────────────────────────────────────────────────────────────┐
# │ ÉTAPE 9: ORCHESTRATEUR - Finalisation                                   │
# │ Durée: ~10ms                                                            │
# └─────────────────────────────────────────────────────────────────────────┘

#     → Tous les nodes sont completed
#     → Résolution des outputs du workflow:

#     outputs.main_asset = "${generate.output.assets}"
#       → nodeRuns.find(n => n.node_id === 'generate').output.assets
#       → [ { url, ... }, { url, ... }, { url, ... }, { url, ... } ]
#
#     outputs.model_used = "${generate.output.metadata.model}"
#       → nodeRuns.find(n => n.node_id === 'generate').output.metadata.model
#       → null (car pas de model spécifié)

#     SQL (finalise le run):
UPDATE v2_workflow_runs
SET status = 'completed',
    outputs = '{
      "main_asset": [
        {"id":"fal-img-1234567890","url":"https://...","type":"image"},
        {"id":"fal-img-1234567891","url":"https://...","type":"image"},
        {"id":"fal-img-1234567892","url":"https://...","type":"image"},
        {"id":"fal-img-1234567893","url":"https://...","type":"image"}
      ],
      "model_used": null
    }',
    completed_at = NOW()
WHERE run_id = 'run_7a8f9e2b-...';

# ┌─────────────────────────────────────────────────────────────────────────┐
# │ ÉTAPE 10: RESPONSE AU CLIENT (Polling)                                  │
# └─────────────────────────────────────────────────────────────────────────┘

#     User fait: GET /api/v2/workflows/runs/run_7a8f9e2b-...

HTTP/1.1 200 OK
{
  "run_id": "run_7a8f9e2b-...",
  "workflow_id": "character-sheet-v1",
  "workflow_version": "1.0.0",
  "status": "completed",
  "nodes": {
    "build_prompt": {
      "status": "completed",
      "attempt": 1,
      "started_at": "2026-07-02T20:30:00Z",
      "completed_at": "2026-07-02T20:30:01Z"
    },
    "generate": {
      "status": "completed",
      "attempt": 1,
      "started_at": "2026-07-02T20:30:02Z",
      "completed_at": "2026-07-02T20:30:08Z"
    }
  },
  "outputs": {
    "main_asset": [
      { "id": "fal-img-1234567890", "url": "https://placehold.co/1024x1024.png", "type": "image" },
      { "id": "fal-img-1234567891", "url": "https://placehold.co/1024x1024.png", "type": "image" },
      { "id": "fal-img-1234567892", "url": "https://placehold.co/1024x1024.png", "type": "image" },
      { "id": "fal-img-1234567893", "url": "https://placehold.co/1024x1024.png", "type": "image" }
    ],
    "model_used": null
  },
  "created_at": "2026-07-02T20:30:00Z",
  "completed_at": "2026-07-02T20:30:08Z"
}

# ┌─────────────────────────────────────────────────────────────────────────┐
# │ RÉSULTAT FINAL: CE QUI EXISTE EN DB                                     │
# └─────────────────────────────────────────────────────────────────────────┘

# === V2 Tables ===
# v2_workflow_runs: 1 ligne (le run)
# v2_workflow_run_nodes: 2 lignes (build_prompt + generate)

# === V1 Tables (créées par le Bridge) ===
# project: 1 ligne ("V2 Works")
# workflow: 1 ligne ("character-sheet-v1 - 7a8f9e2b")
# generation_config: 1 ligne (prompt + model "chatgpt-2")
# media: 4 lignes (les 4 images du character sheet)

# === Billing ===
# transactions: 1 ligne (DÉBIT de 1 crédit, status COMPLETED)

# ═══════════════════════════════════════════════════════════════════════════
# TOTAL: ~10 secondes (avec mock provider)
#        ~30-60 secondes (avec vrai provider Fal/Replicate)
# ═══════════════════════════════════════════════════════════════════════════
