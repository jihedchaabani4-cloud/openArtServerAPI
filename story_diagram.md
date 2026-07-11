# 🎨 V2 Workflow Engine - Edit Media Story Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          USER REQUEST (Edit Image)                            │
│                                                                             │
│   POST /api/v2/workflows/run                                                │
│   {                                                                         │
│     "workflow_id": "edit-image-v1",                                         │
│     "input": {                                                              │
│       "prompt": "remove background",                                        │
│       "source_asset": {                                                     │
│         "id": "asset_123",                                                  │
│         "url": "https://.../cat.png",                                       │
│         "description": "a fluffy orange cat"                                │
│       },                                                                    │
│       "style": "clean white background"                                     │
│     }                                                                       │
│   }                                                                         │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  1️⃣ CONTROLLER (workflowsController.js)                                     │
│                                                                             │
│   ┌─────────────────────────────────────────┐                               │
│   │ validateRunInput()                      │                               │
│   │ • Vérifie que source_asset est présent  │                               │
│   │ • Rejette les champs inconnus           │                               │
│   └─────────────────────────────────────────┘                               │
│                                                                             │
│   ┌─────────────────────────────────────────┐                               │
│   │ resolveModelInput()                     │                               │
│   │ • Si workflow a default_model → l'utilise│                              │
│   │ • Si user envoie model → vérifie si autorisé                          │
│   └─────────────────────────────────────────┘                               │
│                                                                             │
│   ┌─────────────────────────────────────────┐                               │
│   │ compileWorkflow()                       │                               │
│   │ • Charge le YAML edit-image-v1          │                               │
│   │ • Crée l'ExecutionGraph (nodes + edges) │                               │
│   └─────────────────────────────────────────┘                               │
│                                                                             │
│   ┌─────────────────────────────────────────┐                               │
│   │ startWorkflowRun()                      │                               │
│   │ • Crée le run dans la DB (status: pending)                             │
│   │ • Enqueue le job dans BullMQ          │                               │
│   └─────────────────────────────────────────┘                               │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
                                  │ BullMQ Queue
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  2️⃣ WORKER (v2WorkflowWorker.js)                                            │
│                                                                             │
│   bootstrapV2() → charge les providers, adapters, gateways                  │
│                                                                             │
│   ┌─────────────────────────────────────────┐                               │
│   │ processV2WorkflowJob()                  │                               │
│   │ • Récupère le run depuis la DB          │                               │
│   │ • Charge l'ExecutionGraph compilé       │                               │
│   │ • Appelle executeOrchestration()        │                               │
│   └─────────────────────────────────────────┘                               │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  3️⃣ ORCHESTRATOR (workflowRunner.js)                                        │
│                                                                             │
│   executeOrchestration(runId)                                               │
│   │                                                                         │
│   ├─► Tier 1: Nodes sans dépendances                                       │
│   │    │                                                                  │
│   │    └──► build_prompt (prompt-builder)                                 │
│   │         │                                                             │
│   │         │  ┌──────────────────────────────┐                           │
│   │         └──┤ executePromptBuilder()       │                           │
│   │            │                            │                           │
│   │            │ 1. Récupère source_asset    │                           │
│   │            │ 2. buildSourceAssetDescription()                          │
│   │            │    → "a fluffy orange cat sitting on a couch"             │
│   │            │ 3. buildEditPromptPrefix()   │                           │
│   │            │    → "remove background of a fluffy orange cat..."        │
│   │            │ 4. Applique style si présent │                           │
│   │            │    → "..., clean white background"                        │
│   │            │                            │                           │
│   │            │ OUTPUT:                     │                           │
│   │            │ {                           │                           │
│   │            │   finalPrompt: "remove background of a fluffy orange      │
│   │            │               cat sitting on a couch, clean white         │
│   │            │               background",                                  │
│   │            │   context: {                │                           │
│   │            │     edit_context: {         │                           │
│   │            │       source_asset: { id, url, description },             │
│   │            │       operation: "remove background"                      │
│   │            │     }                       │                           │
│   │            │   }                           │                           │
│   │            │ }                             │                           │
│   │            └──────────────────────────────┘                           │
│   │                                                                         │
│   ├─► After build_prompt completes:                                         │
│   │    │                                                                  │
│   │    └──► Vérifie si Tier 2 est prêt (depends_on satisfait)             │
│   │         │                                                             │
│   │         └──► transform (media-transform)                              │
│   │              │                                                        │
│   │              │  ┌────────────────────────────────┐                     │
│   │              └──┤ executeMediaTransform()      │                     │
│   │                 │                              │                     │
│   │                 │ 1. Validate source_asset.url  │                     │
│   │                 │    → https://.../cat.png      │                     │
│   │                 │                              │                     │
│   │                 │ 2. RESERVE BILLING (1 crédit) │                     │
│   │                 │    → billingGateway.reserve() │                     │
│   │                 │    → status: PENDING          │                     │
│   │                 │                              │                     │
│   │                 │ 3. SELECT PROVIDER            │                     │
│   │                 │    → mode: image_edit         │                     │
│   │                 │    → model: flux-kontext      │                     │
│   │                 │    → provider: fal            │                     │
│   │                 │                              │                     │
│   │                 │ 4. BUILD TRANSFORM PAYLOAD  │                     │
│   │                 │    {                          │                     │
│   │                 │      prompt: "remove background...",                  │
│   │                 │      image: "https://.../cat.png",  ← SOURCE IMAGE  │
│   │                 │      width: 1024,             │                     │
│   │                 │      height: 1024,            │                     │
│   │                 │      strength: 0.75,         │                     │
│   │                 │      mode: "image_edit"      │                     │
│   │                 │    }                          │                     │
│   │                 │                              │                     │
│   │                 │ 5. EXECUTE ADAPTER            │                     │
│   │                 │    → adapter.execute(payload) │                     │
│   │                 │    → Provider appelle l'API   │                     │
│   │                 │    → Retourne nouvelle image  │                     │
│   │                 │                              │                     │
│   │                 │ 6. SETTLE BILLING             │                     │
│   │                 │    → billingGateway.settle()│                     │
│   │                 │    → status: COMPLETED      │                     │
│   │                 │                              │                     │
│   │                 │ OUTPUT:                       │                     │
│   │                 │ {                             │                     │
│   │                 │   asset: {                    │                     │
│   │                 │     id: "fal-edit-123456",   │                     │
│   │                 │     url: "https://.../edited.png",                    │
│   │                 │     type: "image",            │                     │
│   │                 │     metadata: {               │                     │
│   │                 │       provider: "fal",        │                     │
│   │                 │       mode: "image_edit",     │                     │
│   │                 │       source_asset_id: "asset_123"                    │
│   │                 │     }                         │                     │
│   │                 │   }                           │                     │
│   │                 │ }                             │                     │
│   │                 └────────────────────────────────┘                     │
│   │                                                                         │
│   ├─► After transform completes:                                            │
│   │    │                                                                  │
│   │    └──► Tous les nodes sont completed                                   │
│   │         │                                                             │
│   │         └──► Résolve les outputs                                      │
│   │              main_asset = transform.output.asset                      │
│   │              edit_context = build_prompt.output.context.edit_context  │
│   │              │                                                        │
│   │              └──► UPDATE RUN (status: completed)                        │
│   │                   completed_at: now                                   │
│   │                   outputs: { main_asset, edit_context }               │
│   │                                                                         │
└─────────────────────────────────┬───────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  4️⃣ RESPONSE AU CLIENT                                                      │
│                                                                             │
│   GET /api/v2/workflows/runs/{run_id}                                       │
│                                                                             │
│   {                                                                         │
│     "run_id": "run_abc123",                                                 │
│     "status": "completed",                                                  │
│     "workflow_id": "edit-image-v1",                                         │
│     "outputs": {                                                            │
│       "main_asset": {                                                       │
│         "id": "fal-edit-123456",                                            │
│         "url": "https://.../edited.png",                                    │
│         "type": "image",                                                    │
│         "metadata": {                                                       │
│           "provider": "fal",                                                │
│           "mode": "image_edit",                                             │
│           "source_asset_id": "asset_123"                                    │
│         }                                                                   │
│       },                                                                    │
│       "edit_context": {                                                     │
│         "source_asset": {                                                   │
│           "id": "asset_123",                                                │
│           "description": "a fluffy orange cat..."                           │
│         },                                                                  │
│         "operation": "remove background"                                    │
│       }                                                                     │
│     }                                                                       │
│   }                                                                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 📊 Storage Mode Comparison

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  OPTION A: VERSIONING (Garder l'historique)                                 │
│                                                                             │
│   [asset_123]  v1 (original)                                                │
│       │                                                                     │
│       ▼ edit "remove bg"                                                    │
│   [asset_124]  v2 (edited)  ← nouveau primary                               │
│       │                                                                     │
│       ▼ edit "add cyberpunk style"                                        │
│   [asset_125]  v3 (re-edited)  ← nouveau primary                            │
│       │                                                                     │
│   DB:                                                                       │
│   ┌───────────┬───────────┬───────────┬───────────┐                       │
│   │ id        │ parent_id │ version   │ primary   │                       │
│   ├───────────┼───────────┼───────────┼───────────┤                       │
│   │ asset_123 │ null      │ 1         │ false     │                       │
│   │ asset_124 │ asset_123 │ 2         │ true      │                       │
│   │ asset_125 │ asset_123 │ 3         │ true      │                       │
│   └───────────┴───────────┴───────────┴───────────┘                       │
│                                                                             │
│   UI:                                                                       │
│   🖼️ Cat.png  [v3] ▼                                                       │
│      ├── v1 Original                                                        │
│      ├── v2 Remove Background                                             │
│      └── v3 Cyberpunk Style                                               │
│                                                                             │
│   ✅ Avantages:                                                           │
│      • Historique complet                                                   │
│      • Peut rollback à n'importe quelle version                           │
│      • User voit l'évolution                                               │
│   ❌ Inconvénients:                                                        │
│      • Plus de stockage                                                    │
│      • Plus de requêtes DB                                                 │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  OPTION B: REPLACE (Écraser)                                              │
│                                                                             │
│   [asset_123]  (original)                                                   │
│       │                                                                     │
│       ▼ edit "remove bg"                                                    │
│   [asset_123]  (même ID, nouvelle URL)  ← écrasé !                         │
│       │                                                                     │
│       ▼ edit "add cyberpunk style"                                        │
│   [asset_123]  (même ID, nouvelle URL)  ← écrasé encore !                  │
│                                                                             │
│   DB:                                                                       │
│   ┌───────────┬───────────┬───────────┐                                   │
│   │ id        │ url       │ prompt    │                                   │
│   ├───────────┼───────────┼───────────┤                                   │
│   │ asset_123 │ edited_v3 │ cyberpunk │  ← seule version existante        │
│   └───────────┴───────────┴───────────┘                                   │
│                                                                             │
│   UI:                                                                       │
│   🖼️ Cat.png                                                               │
│      (une seule version)                                                    │
│                                                                             │
│   ✅ Avantages:                                                           │
│      • Simple                                                              │
│      • Moins de stockage                                                   │
│   ❌ Inconvénients:                                                        │
│      • PAS d'historique                                                    │
│      • Impossible de revenir en arrière                                    │
│      • "Undo" = refaire depuis le début                                    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 🔀 Prompt Builder - Edit vs Generate

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  GENERATE (Création from scratch)                                           │
│                                                                             │
│   Input:                                                                    │
│   { prompt: "a cat in space", style: "digital art" }                        │
│                                                                             │
│   Prompt Builder:                                                           │
│   ┌─────────────────────────────────────────┐                               │
│   │ 1. Récupère prompt: "a cat in space"  │                               │
│   │ 2. Pas de source_asset → mode standard │                               │
│   │ 3. Ajoute style: "digital art"         │                               │
│   │                                         │                               │
│   │ OUTPUT:                                 │                               │
│   │ "a cat in space, digital art"          │                               │
│   └─────────────────────────────────────────┘                               │
│                                                                             │
│   Provider appelé avec:                                                   │
│   { prompt: "a cat in space, digital art", image: null }                    │
│   → CRÉE nouvelle image                                                   │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│  EDIT (Modification d'image existante)                                      │
│                                                                             │
│   Input:                                                                    │
│   {                                                                         │
│     prompt: "remove background",                                            │
│     source_asset: {                                                         │
│       id: "asset_123",                                                      │
│       url: "https://.../cat.png",                                           │
│       description: "a fluffy orange cat sitting on a couch"                 │
│     },                                                                      │
│     style: "clean white background"                                       │
│   }                                                                         │
│                                                                             │
│   Prompt Builder:                                                           │
│   ┌─────────────────────────────────────────┐                               │
│   │ 1. Récupère source_asset               │                               │
│   │ 2. buildSourceAssetDescription()       │                               │
│   │    → "a fluffy orange cat sitting on a couch"                           │
│   │ 3. buildEditPromptPrefix()             │                               │
│   │    → "remove background of a fluffy orange                             │
│   │       cat sitting on a couch"                                           │
│   │ 4. Ajoute style: "clean white background"                             │
│   │                                         │                               │
│   │ OUTPUT:                                 │                               │
│   │ "remove background of a fluffy orange                                   │
│   │  cat sitting on a couch, clean white background"                       │
│   └─────────────────────────────────────────┘                               │
│                                                                             │
│   Provider appelé avec:                                                   │
│   {                                                                         │
│     prompt: "remove background of a fluffy orange...",                      │
│     image: "https://.../cat.png"  ← IMAGE SOURCE (obligatoire)            │
│   }                                                                         │
│   → MODIFIE l'image existante                                             │
│   → Retourne NOUVELLE image avec source_asset_id dans metadata            │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 🏗️ Architecture Layers (Séparation)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  LAYER 1: WORKFLOW ENGINE (Orchestration)                                   │
│                                                                             │
│   • Ne sait PAS qu'il fait un "edit" ou "generate"                        │
│   • C'est juste un graphe de nodes                                        │
│   • Chaque node fait son job indépendamment                               │
│                                                                             │
│   edit-image-v1:                                                          │
│     build_prompt ──► transform                                            │
│                                                                             │
│   simple-image-v1:                                                        │
│     build_prompt ──► generate                                             │
│                                                                             │
│   MÊME orchestration, nodes différents                                  │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  LAYER 2: NODES (Capacités techniques)                                      │
│                                                                             │
│   ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐           │
│   │ prompt-builder  │  │ image-generation│  │ media-transform │           │
│   │                 │  │                 │  │                 │           │
│   │ • build prompt  │  │ • generate NEW  │  │ • transform     │           │
│   │ • aware of      │  │   image         │  │   EXISTING      │           │
│   │   source_asset  │  │ • no source     │  │   asset         │           │
│   │                 │  │   image needed  │  │ • needs source  │           │
│   └─────────────────┘  └─────────────────┘  │   image         │           │
│                                               └─────────────────┘           │
│   CHAQUE NODE EST SPÉCIALISÉ ET RÉUTILISABLE                               │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  LAYER 3: PROVIDERS (Bridge vers V1)                                        │
│                                                                             │
│   ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐           │
│   │ imageAdapter    │  │ videoAdapter    │  │ mediaTransform  │           │
│   │ (V2)            │  │ (V2)            │  │ Adapter (V2)    │           │
│   │                 │  │                 │  │                 │           │
│   │ • generate()    │  │ • generate()    │  │ • editImage()   │           │
│   │   payload       │  │   payload       │  │   (appelle V1)  │           │
│   │                 │  │                 │  │ • editVideo()   │           │
│   └─────────────────┘  └─────────────────┘  │   (appelle V1)  │           │
│                                               └─────────────────┘           │
│   ┌─────────────────────────────────────────┐                               │
│   │         V1 PROVIDERS (Legacy)           │                               │
│   │  ┌─────────┐ ┌─────────┐ ┌─────────┐ │                               │
│   │  │Flux     │ │GPT Image│ │Gemini   │ │                               │
│   │  │Kontext  │ │Edit     │ │Edit     │ │                               │
│   │  └─────────┘ └─────────┘ └─────────┘ │                               │
│   └─────────────────────────────────────────┘                               │
│                                                                             │
│   V2 NE RÉÉCRIT PAS LES PROVIDERS V1 !                                    │
│   V2 les appelle via le bridge adapter                                    │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  LAYER 4: ASSET SERVICE (Persistence)                                       │
│                                                                             │
│   ┌─────────────────────────────────────────┐                               │
│   │  saveAsset({ sourceAssetId, url, mode })│                               │
│   │                                         │                               │
│   │  IF mode == "version":                  │                               │
│   │    → create new media with parent_id    │                               │
│   │    → version = next version             │                               │
│   │                                         │                               │
│   │  IF mode == "replace":                  │                               │
│   │    → update existing media URL          │                               │
│   │    → no new media created               │                               │
│   └─────────────────────────────────────────┘                               │
│                                                                             │
│   C'est ICI qu'on décide "version" vs "replace"                           │
│   Pas dans le workflow, pas dans le node                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 📋 Fichiers créés / modifiés

```
apiOpenArt/
├── src/v2/
│   ├── nodes/
│   │   ├── promptBuilderNode.js          ✅ MODIFIÉ (source_asset + edit_context)
│   │   ├── mediaTransformNode.js         ✅ CRÉÉ (transform node)
│   │   └── index.js                      ✅ MODIFIÉ (registered media-transform)
│   ├── registry/
│   │   ├── nodes.yaml                    ✅ MODIFIÉ (media-transform + source_asset)
│   │   └── workflows/
│   │       ├── edit-image-v1.yaml        ✅ CRÉÉ (workflow edit image)
│   │       └── character-sheet-v1.yaml   ✅ MODIFIÉ (default_model)
│   ├── providers/adapters/
│   │   └── imageAdapter.js               ✅ MODIFIÉ (edit mode metadata)
│   └── runner/
│       └── workflowRunner.js             ⚠️  À MODIFIER (ajouter media-transform)
│
└── src/controllers/v2/
    └── workflowsController.js            ✅ MODIFIÉ (resolveModelInput)
```

---

## 🎯 Prochaines étapes (TODO)

| # | Étape | Fichier | Priorité |
|---|-------|---------|----------|
| 1 | **Fix workflowRunner.js** | Ajouter `media-transform` à `PROVIDER_BACKED_NODE_TYPES` | 🔴 URGENT |
| 2 | Créer `edit-video-v1.yaml` | Workflow pour éditer video | 🟡 Medium |
| 3 | Créer `mediaTransformAdapter.js` | Bridge V1→V2 pour edit providers | 🟡 Medium |
| 4 | Créer `assetService.js` | Versioning / Replace logic | 🟢 Low |
| 5 | Modifier `MediaRepository.js` | Ajouter `parent_media_id`, `version` | 🟢 Low |
| 6 | Test E2E complet | Vérifier que tout fonctionne ensemble | 🟢 Low |

---

## 🧠 Concept clé

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│   "Edit" n'est PAS une capacité différente de "Generate"                  │
│                                                                             │
│   C'est le MÊME provider (Flux, GPT, etc.) mais avec un PAYLOAD différent │
│                                                                             │
│   Generate:  { prompt, image: null }  → CRÉE image                       │
│   Edit:      { prompt, image: URL }     → MODIFIE image                   │
│                                                                             │
│   Le node type change (image-generation → media-transform)              │
│   mais le provider RESTE LE MÊME                                          │
│                                                                             │
│   C'est pourquoi on a un seul node `media-transform` pour tous les edits │
│   et pas `edit-image`, `edit-video`, `edit-upscale` séparés               │
│                                                                             │
│   Le mode (`image_edit`, `video_to_video`) détermine le payload         │
│   et le provider sélectionné                                            │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```
