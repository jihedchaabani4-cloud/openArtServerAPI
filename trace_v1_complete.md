# ═══════════════════════════════════════════════════════════════════════════
# V1 ARCHITECTURE - TRACE COMPLETE
# ═══════════════════════════════════════════════════════════════════════════
#
# V1 = L'architecture originale (avant V2 Workflow Engine)
# V1 utilise des "Treatments" (pas des workflows)
#
# ═══════════════════════════════════════════════════════════════════════════

# ┌─────────────────────────────────────────────────────────────────────────┐
# │ ENTRÉE V1 - Comment l'user appelle V1 ?                                 │
# └─────────────────────────────────────────────────────────────────────────┘
#
# V1 n'a PAS de endpoint /api/v2/workflows/run
# V1 est appelé via les endpoints spécifiques au domaine:
#
#   POST /api/images/generate          → GenerateImageTreatment
#   POST /api/images/edit              → EditImageTreatment
#   POST /api/videos/generate          → VideoTreatment
#   POST /api/videos/edit              → EditVideoTreatment
#   POST /api/images/upscale           → UpscaleTreatment
#   POST /api/images/element-sheet     → ElementSheetTreatment
#
# EXEMPLE: Generate Image V1
POST /api/images/generate
{
  "prompt": "A cyberpunk hacker character",
  "model_name": "nanobana",
  "count": 4,
  "references": [
    { "media_id": "ref_001", "url": "https://.../ref1.jpg" }
  ],
  "userId": "user_123",
  "project_id": "proj_456",
  "session_id": "sess_789"
}

# ┌─────────────────────────────────────────────────────────────────────────┐
# │ V1 TRAITEMENT - Architecture des "Treatments"                            │
# └─────────────────────────────────────────────────────────────────────────┘
#
# V1 n'utilise PAS de workflow engine.
# V1 utilise des classes "Treatment" qui encapsulent TOUTE la logique:
#
#   ┌────────────────────────────┐
#   │   BaseTreatment (abstract)   │
#   │   • prepare(input)         │
#   │   • run(task)              │
#   └────────────┬───────────────┘
#                │
#     ┌──────────┴──────────┐
#     │                     │
#     ▼                     ▼
# ┌─────────────────┐  ┌─────────────────┐
# │BaseGenerateImage│  │  BaseEditImage  │
# │  Treatment      │  │   Treatment     │
# │                 │  │                 │
# │• _runPrepare() │  │• _runPrepare()  │
# │• _runVariation │  │• run()          │
# │• execute()     │  │                 │
# └───────┬─────────┘  └───────┬─────────┘
#         │                    │
#         ▼                    ▼
# ┌─────────────────┐  ┌─────────────────┐
# │GenerateImage    │  │  EditImage      │
# │  Treatment      │  │   Treatment     │
# │                 │  │                 │
# │• prepare()     │  │• prepare()      │
# │• optimizePrompt│  │                 │
# └─────────────────┘  └─────────────────┘
#
# CHAQUE Treatment fait TOUT:
# 1. Crée le workflow
# 2. Crée la config
# 3. Crée le média
# 4. Appelle le provider
# 5. Upload le résultat
# 6. Met à jour le média
#
# C'est "monolithique" - la logique métier et la persistence sont mélangées.

# ┌─────────────────────────────────────────────────────────────────────────┐
# │ ÉTAPE 1: PREPARE (GenerateImageTreatment)                                │
# │ Fichier: src/image/treatments/extendtretment/GenerateImageTreatment.js   │
# └─────────────────────────────────────────────────────────────────────────┘

async prepare(input) {
  // 1. Extrait les paramètres du input
  const {
    prompt,                // "A cyberpunk hacker character"
    model_name = "nanobana",
    count = 1,             // 4 (character sheet)
    references = [],       // [{ media_id: "ref_001" }]
    userId,                // "user_123"
    project_id,          // "proj_456"
    session_id,          // "sess_789"
    ratio, quality, steps, guidance_scale, seed
  } = input;

  // 2. Résout les références (media IDs → URLs enrichies)
  const input_assets = await resolveReferences(this.db, {
    referenceMediaIds: references.map(ref => ref.media_id)
  });
  // → [{ url: "https://.../ref1.jpg", role: "reference", is_base: false }]

  // 3. Délègue au BaseGenerateImageTreatment._runPrepare()
  return this._runPrepare({
    prompt,
    model_name,
    count,
    userId,
    project_id,
    session_id,
    input_assets,          // ← les références enrichies
    stepId: "GEN",         // ← "GEN" pour génération
    // ... autres params
  });
}

# ┌─────────────────────────────────────────────────────────────────────────┐
# │ ÉTAPE 2: _runPrepare (BaseGenerateImageTreatment)                          │
# │ Fichier: src/image/treatments/basetretment/BaseGenerateImageTreatment.js │
# │ Durée: ~100-300ms                                                        │
# └─────────────────────────────────────────────────────────────────────────┘

async _runPrepare(params) {
  const {
    prompt, userId, project_id, session_id,
    model_name, count, stepId, input_assets,
    // ...
  } = params;

  // ── 2a. VÉRIFICATION WALLET ──
  // Vérifie que l'user a assez de crédits
  const wallet = await this.walletService.getWallet(userId);
  const cost = await this.walletService.getCost(model_name, 'image', count);
  if (wallet.balance < cost) {
    throw new Error("Insufficient credits");
  }
  // → Débite les crédits (PENDING)

  // ── 2b. CRÉATION CONFIG ──
  // Crée UNE SEULE config "master" pour le batch
  const config = await this.db.configs.createConfig({
    prompt,
    model: model_name,
    aspect_ratio: ratio || 'SQUARE',
    generation_type: 'TEXT_ONLY',  // ou 'TEXT_REFERENCES' si references
    seed: seed || null,
  });
  // → config_id: "cfg_abc123"

  // ── 2c. CRÉATION WORKFLOW(S) ──
  // Pour count=1: 1 workflow
  // Pour count=4: 4 workflows (1 par variation)
  const workflows = [];
  for (let i = 0; i < count; i++) {
    const wf = await this.db.workflows.createWorkflow({
      project_id,
      session_id,
      display_name: `Generation ${i+1}`,
      workflow_type: 'GENERATION',
    });
    workflows.push(wf);
  }
  // → workflow_ids: ["wf_001", "wf_002", "wf_003", "wf_004"]

  // ── 2d. CRÉATION MEDIA PLACEHOLDERS ──
  // Crée N media "processing" (1 par workflow)
  const mediaIds = [];
  for (const wf of workflows) {
    const media = await appendMediaToWorkflow(this.db, {
      workflow_id: wf.id,
      mediaData: {
        project_id,
        generation_config_id: config.id,  // ← MÊME config pour tous
        step_id: stepId,                 // ← "GEN"
        url: null,                       // ← pas encore généré
        width: 1024, height: 1024,
      },
      initialStatus: 'processing',
      setAsPrimary: true,
    });
    mediaIds.push(media.id);
  }
  // → media_ids: ["med_001", "med_002", "med_003", "med_004"]

  // ── 2e. CONSTRUCTION DU TASK ──
  // Le "task" est l'objet qui traverse toute la pipeline
  return {
    taskId: generateUUID(),
    userId,
    project_id,
    workflows,              // [{ id, ... }, ...]
    mediaIds,               // ["med_001", ...]
    configId: config.id,   // "cfg_abc123"
    prompt,
    model_name,
    count,
    input_assets,           // Références enrichies
    // ... tout le reste
  };
}

# ┌─────────────────────────────────────────────────────────────────────────┐
# │ ÉTAPE 3: RUN (BaseGenerateImageTreatment)                                │
# │ Fichier: src/image/treatments/basetretment/BaseGenerateImageTreatment.js │
# │ Durée: ~5-30s (appel provider)                                             │
# └─────────────────────────────────────────────────────────────────────────┘

async run(task) {
  // ── 3a. OPTIMISATION DU PROMPT ──
  const { finalPrompt, finalNegative } = await this.optimizePrompt(task);
  // → "A cyberpunk hacker character..." (optimisé)
  // → "blurry, low quality..." (negative)

  // ── 3b. CONSTRUCTION DU PAYLOAD PROVIDER ──
  // Pour CHAQUE variation
  for (let i = 0; i < task.count; i++) {
    const form = {
      prompt: finalPrompt,
      negativePrompt: finalNegative,
      image: null,              // ← PAS d'image source (génération)
      references: task.input_assets,  // ← Images d'inspiration
      width: 1024, height: 1024,
      seed: task.seed + i,      // ← Seed différente par variation
    };

    // Adapte le payload selon le provider
    const payload = this._buildPayload(task.model_name, form);

    // ── 3c. APPEL AU PROVIDER ──
    const provider = this._getProvider(task.model_name);
    const result = await provider.generate(payload);
    // → { url: "https://provider.com/result.png", width: 1024, height: 1024 }

    // ── 3d. UPLOAD VERS STORAGE ──
    const fileName = `${task.userId}/generations/${task.workflows[i].id}_${Date.now()}.png`;
    const fileUrl = await this.storageService.uploadFromUrl(fileName, result.url);
    // → fileUrl: "https://storage.openart.com/u123/generations/wf_001_1234567890.png"

    // ── 3e. CRÉATION CONFIG PAR VARIATION ──
    // Chaque variation a SA PROPRE config (pas la master)
    const mediaConfig = await this.db.configs.createConfig({
      prompt: finalPrompt,
      model: task.model_name,
      aspect_ratio: 'SQUARE',
      generation_type: 'TEXT_ONLY',
      seed: task.seed + i,
    });

    // ── 3f. UPDATE MEDIA ──
    await this.db.media.updateFields(task.mediaIds[i], {
      generation_config_id: mediaConfig.id,  // ← Config spécifique
      url: fileUrl,
      width: result.width,
      height: result.height,
    });

    // ── 3g. MARK SUCCESS ──
    await markMediaStatus(this.db, task.mediaIds[i], 'success');
  }

  // ── 3h. CONFIRM BILLING ──
  await this.walletService.confirmTransaction(task.transactionId);
  // → PENDING → COMPLETED

  return {
    workflows: task.workflows,
    mediaIds: task.mediaIds,
  };
}

# ┌─────────────────────────────────────────────────────────────────────────┐
# │ EDIT V1 - Différence avec Generate                                        │
# │ Fichier: src/image/treatments/extendtretment/EditImageTreatment.js      │
# │ + src/image/treatments/basetretment/BaseEditTreatment.js                 │
# └─────────────────────────────────────────────────────────────────────────┘

# PREPARE (EditImageTreatment)
async prepare({
  prompt,                    // "remove background"
  model_name = "nanobana",
  workflow_id,               // ← OBLIGATOIRE (workflow EXISTANT)
  reference_media_ids = [],
  userId, project_id, session_id,
}) {
  // 1. Résout les références
  //    INCLUT le workflow_id → récupère le media principal du workflow
  const references = await resolveReferences(this.db, {
    baseWorkflowId: workflow_id,        // ← RÉCUPÈRE le media du workflow
    referenceMediaIds: reference_media_ids,
  });
  // → references = [
  //     { url: "https://.../cat.png", is_base: true, media_id: "med_001" },  ← L'image à modifier
  //     { url: "https://.../style.jpg", is_base: false }                    ← Inspiration
  //   ]

  // 2. Délègue au BaseEditTreatment
  return this._runPrepare({
    prompt,
    references,             // ← Contient le source + refs
    model_name,
    userId, project_id, session_id,
    workflow_id,              // ← Workflow EXISTANT (pas nouveau)
    stepId: "EDIT",
  });
}

# _runPrepare (BaseEditTreatment)
async _runPrepare(params) {
  const { prompt, workflow_id, references, userId, project_id, stepId } = params;

  // ── RÉCUPÈRE LE WORKFLOW EXISTANT ──
  const wf = await this.db.workflows.getWorkflow(workflow_id);
  if (!wf) throw new Error(`Workflow "${workflow_id}" not found`);

  // ── CRÉATION CONFIG (master) ──
  const config = await this.db.configs.createConfig({
    prompt,
    model: params.model_name,
    aspect_ratio: 'SQUARE',
    generation_type: 'TEXT_REFERENCES',  // ← Toujours TEXT_REFERENCES
  });

  // ── CRÉATION MEDIA (1 seul, pas N) ──
  const media = await appendMediaToWorkflow(this.db, {
    workflow_id: wf.id,        // ← MÊME workflow (pas nouveau)
    mediaData: {
      project_id,
      generation_config_id: config.id,
      step_id: stepId,          // ← "EDIT"
      url: null,
      width: 1024, height: 1024,
    },
    initialStatus: 'processing',
    setAsPrimary: true,         // ← DEVIENT le nouveau primary!
  });
  // → media_id: "med_edit_001"

  // Construction du task
  return {
    taskId: generateUUID(),
    workflowId: wf.id,          // ← Workflow EXISTANT
    mediaId: media.id,          // ← Nouveau media
    configId: config.id,
    prompt,
    references,                // ← AVEC le source_asset (is_base: true)
    // ...
  };
}

# RUN (BaseEditTreatment)
async run(task) {
  // ── 1. TROUVE L'IMAGE SOURCE ──
  const sourceAsset = task.references.find(
    ref => ref.is_base || ref.role === 'source'
  ) || task.references[0];
  // → { url: "https://.../cat.png", is_base: true }

  // ── 2. OPTIMISE LE PROMPT (mode edit) ──
  const { finalPrompt, finalNegative } = await this.optimizePrompt(task, { isEdit: true });
  // → "remove background of a fluffy orange cat..."

  // ── 3. CONSTRUIT LE PAYLOAD ──
  //    DIFFÉRENCE CLÉ: image_url est présent!
  const form = {
    prompt: finalPrompt,
    image: sourceAsset.url,           // ← IMAGE SOURCE (obligatoire)
    image_url: sourceAsset.url,
    references: task.references,     // ← Toutes les refs (source + inspiration)
  };

  // ── 4. APPELLE LE PROVIDER ──
  const provider = this._getProvider(task.model_name);
  const payload = provider.buildPayload(form) || provider.adapt(form);
  const result = await provider.generate(payload);
  // → { url: "https://provider.com/edited.png" }

  // ── 5. UPLOAD ──
  const fileName = `${task.userId}/edits/${task.workflowId}_${Date.now()}.png`;
  const fileUrl = await this.storageService.uploadFromUrl(fileName, result.url);
  // → fileUrl: "https://storage.../u123/edits/wf_001_1234567890.png"

  // ── 6. UPDATE MEDIA ──
  await this.db.media.updateFields(task.mediaId, {
    url: fileUrl,
    width: result.width,
    height: result.height,
  });

  // ── 7. MARK SUCCESS ──
  await markMediaStatus(this.db, task.mediaId, 'success');

  // ── 8. UPDATE WORKFLOW PRIMARY ──
  //    Le nouveau media devient le primary!
  await this.db.workflows.updateFields(task.workflowId, {
    primary_media_id: task.mediaId,   // ← REMPLACE l'ancien primary
  });

  return { mediaId: task.mediaId, workflowId: task.workflowId };
}

# ┌─────────────────────────────────────────────────────────────────────────┐
# │ RÉSULTAT V1 - CE QUI EXISTE EN DB                                       │
# └─────────────────────────────────────────────────────────────────────────┘

# ====== GENERATE (count=1) ======
# Table: workflow
# ┌─────────┬──────────┬─────────────────────┬──────────┬──────────────────┐
# │ id      │ project  │ display_name        │ type     │ primary_media_id │
# ├─────────┼──────────┼─────────────────────┼──────────┼──────────────────┤
# │ wf_001  │ proj_456 │ Generation 1        │ GENERATN │ med_001          │
# └─────────┴──────────┴─────────────────────┴──────────┴──────────────────┘
#
# Table: generation_config
# ┌─────────┬─────────────────────────────┬──────────┬─────────┬──────────┐
# │ id      │ prompt                      │ model    │ ratio   │ type     │
# ├─────────┼─────────────────────────────┼──────────┼─────────┼──────────┤
# │ cfg_001 │ A cyberpunk hacker...      │ nanobana │ SQUARE  │ TEXT_ONLY│
# └─────────┴─────────────────────────────┴──────────┴─────────┴──────────┘
#
# Table: media
# ┌─────────┬──────────┬──────────┬──────────────────┬──────────┬──────────┐
# │ id      │ workflow │ project  │ gen_config_id    │ step_id  │ url      │
# ├─────────┼──────────┼──────────┼──────────────────┼──────────┼──────────┤
# │ med_001 │ wf_001   │ proj_456 │ cfg_001          │ GEN      │ https://...│
# └─────────┴──────────┴──────────┴──────────────────┴──────────┴──────────┘
#
# ====== GENERATE (count=4) ======
# Table: workflow (×4)
# │ wf_001  │ Generation 1        │ GEN      │ med_001  │
# │ wf_002  │ Generation 2        │ GEN      │ med_002  │
# │ wf_003  │ Generation 3        │ GEN      │ med_003  │
# │ wf_004  │ Generation 4        │ GEN      │ med_004  │
#
# Table: media (×4)
# │ med_001 │ wf_001   │ cfg_001  │ GEN      │ https://...│
# │ med_002 │ wf_002   │ cfg_002  │ GEN      │ https://...│  ← Config différente par variation
# │ med_003 │ wf_003   │ cfg_003  │ GEN      │ https://...│
# │ med_004 │ wf_004   │ cfg_004  │ GEN      │ https://...│
#
# ====== EDIT (1×) ======
# Table: workflow (MÊME, pas nouveau)
# │ wf_001  │ Generation 1        │ GEN      │ med_edit_001 │ ← primary CHANGÉ!
#
# Table: media (NOUVEAU + ANCIEN)
# │ med_001     │ wf_001   │ cfg_001  │ GEN      │ https://.../cat.png     │ ← Ancien (plus primary)
# │ med_edit_001│ wf_001   │ cfg_edit │ EDIT     │ https://.../cat_no_bg.png│ ← NOUVEAU (primary)
#
# ====== EDIT (2×) ======
# Table: media (3 lignes pour le même workflow)
# │ med_001     │ wf_001   │ cfg_001      │ GEN      │ cat.png       │
# │ med_edit_001│ wf_001   │ cfg_edit_001 │ EDIT     │ cat_no_bg.png │
# │ med_edit_002│ wf_001   │ cfg_edit_002 │ EDIT     │ cat_anime.png │ ← NEW primary

# ┌─────────────────────────────────────────────────────────────────────────┐
# │ DIFFÉRENCE V1 vs V2 - Architecture                                       │
# └─────────────────────────────────────────────────────────────────────────┘
#
# ╔═══════════════════════════════════════╦═══════════════════════════════════════╗
# ║              V1                         ║              V2                       ║
# ╠═══════════════════════════════════════╬═══════════════════════════════════════╣
# ║  "Treatments"                         ║  "Workflow Engine"                    ║
# ║  Chaque classe fait TOUT              ║  Séparation en nodes + orchestrateur ║
# ╠═══════════════════════════════════════╬═══════════════════════════════════════╣
# ║  GenerateImageTreatment               ║  build_prompt → image-generation     ║
# ║  ├── crée workflow                    ║  (nodes séparés, réutilisables)       ║
# ║  ├── crée config                      ║                                       ║
# ║  ├── crée media                       ║                                       ║
# ║  ├── appelle provider                 ║                                       ║
# ║  ├── upload                           ║                                       ║
# ║  └── update DB                        ║                                       ║
# ╠═══════════════════════════════════════╬═══════════════════════════════════════╣
# ║  EditImageTreatment                   ║  build_prompt → media-transform      ║
# ║  ├── récupère workflow existant       ║  (même nodes, config différente)     ║
# ║  ├── crée config                      ║                                       ║
# ║  ├── crée media                       ║                                       ║
# ║  ├── appelle provider (avec image)    ║                                       ║
# ║  ├── upload                           ║                                       ║
# ║  └── update workflow.primary_media   ║                                       ║
# ╠═══════════════════════════════════════╬═══════════════════════════════════════╣
# ║  Code dupliqué entre treatments     ║  Nodes réutilisables                  ║
# ║  (BaseGenerate, BaseEdit, Video...)   ║  (prompt-builder, image-gen, etc.)    ║
# ╠═══════════════════════════════════════╬═══════════════════════════════════════╣
# ║  Pas de graphe d'exécution            ║  ExecutionGraph (nodes + edges)     ║
# ║  Pas de retry automatique             ║  RetryExecutor (max_attempts, backoff)║
# ║  Pas de billing par node              ║  Billing par node (reserve/settle)   ║
# ╠═══════════════════════════════════════╬═══════════════════════════════════════╣
# ║  Endpoints spécifiques                ║  Endpoint unique /v2/workflows/run    ║
# ║  /api/images/generate                 ║  + workflow_id dans le body          ║
# ║  /api/images/edit                     ║                                       ║
# ║  /api/videos/generate                 ║                                       ║
# ║  /api/videos/edit                     ║                                       ║
# ╠═══════════════════════════════════════╬═══════════════════════════════════════╣
# ║  DB: V1 tables seulement              ║  DB: V1 + V2 tables                   ║
# ║  (workflow, media, config)            ║  (+ v2_workflow_runs, nodes)          ║
# ╠═══════════════════════════════════════╬═══════════════════════════════════════╣
# ║  Stockage: direct dans treatment     ║  Stockage: via bridge V1              ║
# ║  (createWorkflow + createMedia)       ║  (V1StorageBridge)                    ║
# ╚═══════════════════════════════════════╩═══════════════════════════════════════╝

# ┌─────────────────────────────────────────────────────────────────────────┐
# │ V1 EN DEUX MOTS                                                         │
# └─────────────────────────────────────────────────────────────────────────┘
#
#   V1 = "Traitement monolithique"
#   ═══════════════════════════════
#
#   Chaque opération (generate, edit, upscale) a SA PROPRE classe qui fait TOUT:
#   • Valide les inputs
#   • Crée le workflow
#   • Crée la config
#   • Crée le media
#   • Appelle le provider
#   • Upload le résultat
#   • Met à jour la DB
#   • Gère les crédits
#
#   Avantages:
#   ✅ Simple à comprendre (tout dans une classe)
#   ✅ Direct, pas d'indirection
#
#   Inconvénients:
#   ❌ Code dupliqué (chaque treatment recrée la logique persistence)
#   ❌ Pas de retry automatique
#   ❌ Pas de graphe d'exécution visible
#   ❌ Difficile à étendre (ajouter un nouveau type = copier/coller)
#   ❌ Pas de séparation métier / technique
#
#   ═══════════════════════════════════════════════════════════════════════
#   V2 = "Moteur de workflow déclaratif"
#   ═══════════════════════════════════════════════════════════════════════
#
#   Les opérations sont décomposées en NODES réutilisables:
#   • prompt-builder (compétence métier)
#   • image-generation (compétence technique)
#   • media-transform (compétence technique)
#   • upscale (compétence technique)
#
#   Le YAML déclare le graphe (nodes + edges), l'orchestrateur exécute.
#   Les nodes sont indépendants et réutilisables.
#
#   Avantages:
#   ✅ Séparation métier / technique
#   ✅ Réutilisabilité (même node pour generate et edit)
#   ✅ Retry automatique par node
#   ✅ Billing par node
#   ✅ Facile à étendre (nouveau workflow = nouveau YAML)
#   ✅ Graphe visible (debug, monitoring)
#
#   Inconvénients:
#   ⚠ Plus complexe (plus de fichiers, plus d'indirection)
#   ⚠ Besoin de bridge pour V1 (2 systèmes coexistent)
#
#   ═══════════════════════════════════════════════════════════════════════
#   V1 + V2 (Bridge) = "V2 orchestre, V1 stocke"
#   ═══════════════════════════════════════════════════════════════════════
#
#   V2 gère l'exécution (nodes, retry, billing)
#   V1 gère la persistence (workflow, media, config)
#   C'est le meilleur des deux mondes!
#