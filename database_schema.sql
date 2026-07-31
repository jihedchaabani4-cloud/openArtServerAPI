-- ═══════════════════════════════════════════════════════════════════════════════
--  OPENART DATABASE SCHEMA - VERSION COMPLETE (V1 + V2)
-- ═══════════════════════════════════════════════════════════════════════════════
--  Ce fichier est la source de vérité pour la structure de la base de données.
--  Il documente:
--    • Les tables V1 (Génération d'images/vidéos, Media Library)
--    • Les tables V2 (Workflow Engine)
--    • Les relations et contraintes entre tables
--    • Les enums et types personnalisés
--
--  ORDRE DE CRÉATION:
--    1. Extensions & Types (ENUMs)
--    2. Tables Auth (Supabase)
--    3. Tables V1 Core (Project → Session → Workflow → Media)
--    4. Tables V1 Config (generation_config, references, DNA)
--    5. Tables Billing (Wallets, Transactions)
--    6. Tables V2 (Workflow Engine)
--    7. Indexes & RLS Policies
-- ═══════════════════════════════════════════════════════════════════════════════

-- ┌─────────────────────────────────────────────────────────────────────────────┐
-- │ 0. EXTENSIONS                                                               │
-- └─────────────────────────────────────────────────────────────────────────────┘

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ┌─────────────────────────────────────────────────────────────────────────────┐
-- │ 1. ENUMS & TYPES PERSONNALISÉS                                              │
-- └─────────────────────────────────────────────────────────────────────────────┘

-- Types de transaction (crédits)
CREATE TYPE transaction_type AS ENUM ('CREDIT', 'DEBIT', 'REFUND');
CREATE TYPE transaction_status AS ENUM ('PENDING', 'COMPLETED', 'FAILED', 'EXPIRED');

-- Types de workflow V1
CREATE TYPE workflow_type AS ENUM ('GENERATION', 'ELEMENT_SHEET');

-- Types d'input pour les références d'image
CREATE TYPE image_input_type AS ENUM (
  'IMAGE_INPUT_TYPE_REFERENCE',    -- Image d'inspiration (référence)
  'IMAGE_INPUT_TYPE_BASE_IMAGE',   -- Image de base à modifier (edit)
  'IMAGE_INPUT_TYPE_START_FRAME',  -- Frame de début (vidéo)
  'IMAGE_INPUT_TYPE_END_FRAME'     -- Frame de fin (vidéo)
);

-- Statut des médias
CREATE TYPE media_status AS ENUM ('processing', 'success', 'failed');

-- ┌─────────────────────────────────────────────────────────────────────────────┐
-- │ 2. TABLES AUTH (Supabase intégré)                                           │
-- └─────────────────────────────────────────────────────────────────────────────┘
--
-- Note: La table auth.users est gérée par Supabase Auth.
-- Les tables profiles et wallets s'y lient via user_id.

-- ┌─────────────────────────────────────────────────────────────────────────────┐
-- │ 3. TABLES V1 CORE                                                           │
-- │                                                                             │
-- │  Architecture: Project → Session → Workflow → Media                         │
-- │                                                                             │
-- │  Project: Conteneur principal (ex: "Projet Marketing")
-- │  Session: Groupe logique dans un projet (ex: "Hero Images")
-- │  Workflow: Instance de génération (ex: "Génération #1")
-- │  Media: Asset produit (image, vidéo)
-- └─────────────────────────────────────────────────────────────────────────────┘

-- ╔═════════════════════════════════════════════════════════════════════════════╗
-- ║ TABLE: project                                                              ║
-- ║ Description: Conteneur principal. Un projet regroupe plusieurs sessions.    ║
-- ╚═════════════════════════════════════════════════════════════════════════════╝
CREATE TABLE public.project (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_name text NOT NULL,
  create_time timestamp with time zone NOT NULL DEFAULT now(),
  user_id uuid,
  
  CONSTRAINT project_pkey PRIMARY KEY (id)
);

COMMENT ON TABLE public.project IS 'Conteneur principal de l utilisateur. Ex: "Campagne été 2025"';
COMMENT ON COLUMN public.project.user_id IS 'Lien vers auth.users (Supabase)';

-- ╔═════════════════════════════════════════════════════════════════════════════╗
-- ║ TABLE: session                                                              ║
-- ║ Description: Groupe logique de workflows dans un projet.                   ║
-- ║ Ex: "Hero Section", "Gallery", "Video Ads"                                  ║
-- ╚═════════════════════════════════════════════════════════════════════════════╝
CREATE TABLE public.session (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  name text NOT NULL,
  position smallint NOT NULL DEFAULT 0,  -- Ordre d'affichage dans l'UI
  create_time timestamp with time zone NOT NULL DEFAULT now(),
  
  CONSTRAINT session_pkey PRIMARY KEY (id),
  CONSTRAINT session_project_id_fkey 
    FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE CASCADE
);

COMMENT ON TABLE public.session IS 'Groupe logique de workflows. Ex: "Hero Images", "Thumbnails"';

-- ╔═════════════════════════════════════════════════════════════════════════════╗
-- ║ TABLE: workflow                                                             ║
-- ║ Description: Instance de génération. Chaque workflow produit des médias.   ║
-- ║                                                                             ║
-- ║ Types:                                                                      ║
-- ║   • GENERATION: Création from scratch (prompt → image)                     ║
-- ║   • ELEMENT_SHEET: Character sheet, style guide                            ║
-- ╚═════════════════════════════════════════════════════════════════════════════╝
CREATE TABLE public.workflow (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  session_id uuid,
  display_name text NOT NULL,
  variation_index smallint CHECK (variation_index >= 0),
  primary_media_id uuid,  -- Média principal affiché dans l'UI
  create_time timestamp with time zone NOT NULL DEFAULT now(),
  favorited boolean DEFAULT false,
  workflow_type workflow_type NOT NULL DEFAULT 'GENERATION'::workflow_type,
  
  CONSTRAINT workflow_pkey PRIMARY KEY (id),
  CONSTRAINT workflow_project_id_fkey 
    FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE CASCADE,
  CONSTRAINT workflow_session_id_fkey 
    FOREIGN KEY (session_id) REFERENCES public.session(id) ON DELETE SET NULL,
  CONSTRAINT fk_workflow_primary_media 
    FOREIGN KEY (primary_media_id) REFERENCES public.media(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.workflow IS 'Instance de génération. Chaque workflow produit 1 ou N médias';
COMMENT ON COLUMN public.workflow.primary_media_id IS 'Média affiché comme thumbnail dans l UI';

-- ╔═════════════════════════════════════════════════════════════════════════════╗
-- ║ TABLE: media                                                                ║
-- ║ Description: Asset produit (image, vidéo). Le coeur du système.             ║
-- ║                                                                             ║
-- ║ Note sur l edit:                                                            ║
-- ║   • En V1, les edits créent un NOUVEAU media lié au MÊME workflow          ║
-- ║   • Le workflow.primary_media_id pointe vers le DERNIER edit              ║
-- ║   • L historique est retrouvé via workflow_id + ORDER BY create_time       ║
-- ║                                                                             ║
-- ║ Amélioration V2 proposée:                                                   ║
-- ║   • parent_media_id: Lien vers l original (versioning)                     ║
-- ║   • version: Numéro de version (1, 2, 3...)                                ║
-- ║   • asset_family_id: Groupe les versions d un même asset                   ║
-- ╚═════════════════════════════════════════════════════════════════════════════╝
CREATE TABLE public.media (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL,
  project_id uuid NOT NULL,
  generation_config_id uuid,
  step_id text NOT NULL,  -- "GEN", "EDIT", "VID", "UPSCALE"
  url text,
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  create_time timestamp with time zone NOT NULL DEFAULT now(),
  status media_status DEFAULT 'processing'::media_status,
  error_message text,
  
  -- ═══ CHAMPS V2 PROPOSÉS POUR VERSIONING ═══
  -- parent_media_id uuid,  -- Lien vers l asset original (NULL si v1)
  -- version integer DEFAULT 1,  -- Numéro de version
  -- asset_family_id uuid,  -- Groupe les versions du même asset
  -- metadata jsonb DEFAULT '{}'::jsonb,  -- { provider, model, mode, prompt }
  
  CONSTRAINT media_pkey PRIMARY KEY (id),
  CONSTRAINT media_workflow_id_fkey 
    FOREIGN KEY (workflow_id) REFERENCES public.workflow(id) ON DELETE CASCADE,
  CONSTRAINT media_project_id_fkey 
    FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE CASCADE,
  CONSTRAINT media_generation_config_id_fkey 
    FOREIGN KEY (generation_config_id) REFERENCES public.generation_config(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.media IS 'Asset produit (image ou vidéo). Coeur du système.';
COMMENT ON COLUMN public.media.step_id IS 'Origine: GEN=generation, EDIT=edit, VID=video, UPS=upscale';

-- ╔═════════════════════════════════════════════════════════════════════════════╗
-- ║ TABLE: batch                                                                ║
-- ║ Description: Groupe de variations. Un batch = N workflows identiques.      ║
-- ║ Ex: Générer 4 variations d un même prompt                                  ║
-- ╚═════════════════════════════════════════════════════════════════════════════╝
CREATE TABLE public.batch (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  session_id uuid NOT NULL,
  generation_config_id uuid NOT NULL,
  variation_count smallint NOT NULL CHECK (variation_count >= 1 AND variation_count <= 14),
  create_time timestamp with time zone NOT NULL DEFAULT now(),
  
  CONSTRAINT batch_pkey PRIMARY KEY (id),
  CONSTRAINT batch_project_id_fkey 
    FOREIGN KEY (project_id) REFERENCES public.project(id) ON DELETE CASCADE,
  CONSTRAINT batch_session_id_fkey 
    FOREIGN KEY (session_id) REFERENCES public.session(id) ON DELETE CASCADE,
  CONSTRAINT fk_batch_generation_config 
    FOREIGN KEY (generation_config_id) REFERENCES public.generation_config(id)
);

-- ┌─────────────────────────────────────────────────────────────────────────────┐
-- │ 4. TABLES V1 CONFIG (Generation Configuration)                              │
-- │                                                                             │
-- │  generation_config: Paramètres de génération (prompt, model, etc.)          │
-- │  generation_config_reference: Liens entre config et médias de référence     │
-- │  dna: Personnages/éléments réutilisables (character sheets)                │
-- └─────────────────────────────────────────────────────────────────────────────┘

-- ╔═════════════════════════════════════════════════════════════════════════════╗
-- ║ TABLE: generation_config                                                    ║
-- ║ Description: Paramètres de génération. Peut être réutilisé.                ║
-- ╚═════════════════════════════════════════════════════════════════════════════╝
CREATE TABLE public.generation_config (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  prompt text NOT NULL,
  model text NOT NULL,
  aspect_ratio text NOT NULL,
  generation_type text NOT NULL,  -- "TEXT_ONLY", "TEXT_REFERENCES", "IMAGE_TO_IMAGE"
  seed bigint,
  visibility text NOT NULL DEFAULT 'PRIVATE'::text 
    CHECK (visibility = ANY (ARRAY['PRIVATE'::text, 'PUBLIC'::text])),
  prompt_optimise text,  -- Version optimisée par l'IA du prompt
  
  CONSTRAINT generation_config_pkey PRIMARY KEY (id)
);

COMMENT ON COLUMN public.generation_config.generation_type IS 
  'TEXT_ONLY=prompt seul, TEXT_REFERENCES=prompt+refs, IMAGE_TO_IMAGE=edit';

-- ╔═════════════════════════════════════════════════════════════════════════════╗
-- ║ TABLE: generation_config_reference                                          ║
-- ║ Description: Lien entre une config et les médias de référence.             ║
-- ║                                                                             ║
-- ║ Types de référence:                                                         ║
-- ║   • REFERENCE: Image d inspiration (génération)                            ║
-- ║   • BASE_IMAGE: Image à modifier (edit)                                    ║
-- ║   • START_FRAME: Frame de début (vidéo)                                    ║
-- ║   • END_FRAME: Frame de fin (vidéo)                                        ║
-- ╚═════════════════════════════════════════════════════════════════════════════╝
CREATE TABLE public.generation_config_reference (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  generation_config_id uuid NOT NULL,
  position smallint NOT NULL CHECK (position >= 0 AND position <= 13),
  input_type image_input_type NOT NULL,
  ref_media_id uuid NOT NULL,  -- Lien vers media (l'image de référence)
  
  CONSTRAINT generation_config_reference_pkey PRIMARY KEY (id),
  CONSTRAINT generation_config_reference_ref_media_id_fkey 
    FOREIGN KEY (ref_media_id) REFERENCES public.media(id) ON DELETE CASCADE,
  CONSTRAINT generation_config_reference_generation_config_id_fkey 
    FOREIGN KEY (generation_config_id) REFERENCES public.generation_config(id) ON DELETE CASCADE
);

COMMENT ON COLUMN public.generation_config_reference.input_type IS 
  'REFERENCE=inspiration, BASE_IMAGE=image à modifier (edit), START/END_FRAME=vidéo';

-- ╔═════════════════════════════════════════════════════════════════════════════╗
-- ║ TABLE: dna                                                                  ║
-- ║ Description: Personnages/éléments réutilisables (character sheets).        ║
-- ╚═════════════════════════════════════════════════════════════════════════════╝
CREATE TABLE public.dna (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  generation_config_id uuid NOT NULL,
  name text NOT NULL,
  type text NOT NULL,
  description text,
  traits jsonb NOT NULL DEFAULT '{}'::jsonb,  -- { hair: "red", eyes: "blue", ... }
  create_time timestamp with time zone NOT NULL DEFAULT now(),
  
  CONSTRAINT dna_pkey PRIMARY KEY (id),
  CONSTRAINT dna_generation_config_id_fkey 
    FOREIGN KEY (generation_config_id) REFERENCES public.generation_config(id) ON DELETE CASCADE
);

-- ┌─────────────────────────────────────────────────────────────────────────────┐
-- │ 5. TABLES BILLING (Crédits & Paiements)                                     │
-- │                                                                             │
-- │  profiles: Profil utilisateur (lié à auth.users)                            │
-- │  wallets: Solde de crédits                                                  │
-- │  transactions: Historique des mouvements de crédits                        │
-- │  credit_packages: Forfaits de crédits disponibles                          │
-- └─────────────────────────────────────────────────────────────────────────────┘

-- ╔═════════════════════════════════════════════════════════════════════════════╗
-- ║ TABLE: profiles                                                             ║
-- ║ Description: Profil utilisateur. Synchronisé avec Supabase Auth.           ║
-- ╚═════════════════════════════════════════════════════════════════════════════╝
CREATE TABLE public.profiles (
  id uuid NOT NULL,
  email text,
  full_name text,
  avatar_url text,
  created_at timestamp with time zone DEFAULT now(),
  credits integer DEFAULT 0,  -- ⚠️ Déprécié, utilise wallets.balance
  
  CONSTRAINT profiles_pkey PRIMARY KEY (id),
  CONSTRAINT profiles_id_fkey 
    FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE
);

-- ╔═════════════════════════════════════════════════════════════════════════════╗
-- ║ TABLE: wallets                                                              ║
-- ║ Description: Solde de crédits de l'utilisateur.                            ║
-- ╚═════════════════════════════════════════════════════════════════════════════╝
CREATE TABLE public.wallets (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  balance numeric DEFAULT 0.00 CHECK (balance >= 0::numeric),
  updated_at timestamp with time zone DEFAULT now(),
  
  CONSTRAINT wallets_pkey PRIMARY KEY (id),
  CONSTRAINT fk_wallets_user 
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE
);

-- ╔═════════════════════════════════════════════════════════════════════════════╗
-- ║ TABLE: transactions                                                         ║
-- ║ Description: Historique des mouvements de crédits.                         ║
-- ║                                                                             ║
-- ║ Types:                                                                      ║
-- ║   • CREDIT: Ajout de crédits (achat, bonus)                                ║
-- ║   • DEBIT: Consommation (génération, edit)                                 ║
-- ║   • REFUND: Remboursement                                                  ║
-- ╚═════════════════════════════════════════════════════════════════════════════╝
CREATE TABLE public.transactions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  wallet_id uuid NOT NULL,
  amount numeric NOT NULL,
  type transaction_type NOT NULL,
  status transaction_status DEFAULT 'PENDING'::transaction_status,
  reference_id character varying NOT NULL UNIQUE,  -- Idempotency key
  metadata jsonb DEFAULT '{}'::jsonb,  -- { workflow_id, node_id, reason }
  expires_at timestamp with time zone NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  
  CONSTRAINT transactions_pkey PRIMARY KEY (id),
  CONSTRAINT transactions_wallet_id_fkey 
    FOREIGN KEY (wallet_id) REFERENCES public.wallets(id) ON DELETE CASCADE
);

COMMENT ON COLUMN public.transactions.reference_id IS 'Clé d idempotence: v2:run_id:node_id:attempt';
COMMENT ON COLUMN public.transactions.metadata IS 'Contexte: workflow_id, node_id, provider, etc.';

-- ╔═════════════════════════════════════════════════════════════════════════════╗
-- ║ TABLE: credit_packages                                                      ║
-- ║ Description: Forfaits de crédits disponibles à l'achat.                    ║
-- ╚═════════════════════════════════════════════════════════════════════════════╝
CREATE TABLE public.credit_packages (
  id text NOT NULL,
  label text NOT NULL,
  credits integer NOT NULL,
  price numeric NOT NULL,
  currency text NOT NULL DEFAULT 'USD'::text,
  yearly_price numeric,
  variant_id text,
  checkout_url text,
  popular boolean DEFAULT false,
  is_trial boolean DEFAULT false,
  is_active boolean DEFAULT true,
  sort_order integer DEFAULT 0,
  description text,
  features jsonb NOT NULL DEFAULT '[]'::jsonb,  -- ["HD Export", "Priority Queue"]
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  plan_type text CHECK (plan_type = ANY (ARRAY['subscription'::text, 'one-time'::text])),
  
  CONSTRAINT credit_packages_pkey PRIMARY KEY (id)
);

-- ┌─────────────────────────────────────────────────────────────────────────────┐
-- │ 6. TABLES V2 (Workflow Engine)                                              │
-- │                                                                             │
-- │  Architecture séparée du V1. Le V2 engine utilise ses propres tables.      │
-- │  Les médias produits par V2 peuvent être synchronisés vers V1.             │
-- └─────────────────────────────────────────────────────────────────────────────┘

-- ╔═════════════════════════════════════════════════════════════════════════════╗
-- ║ TABLE: v2_workflow_runs                                                     ║
-- ║ Description: Instance d exécution V2. Le cœur du nouveau moteur.           ║
-- ║                                                                             ║
-- ║ Champs importants:                                                          ║
-- ║   • input: JSON des inputs utilisateur                                     ║
-- ║   • execution_plan: Le graphe d exécution compilé                          ║
-- ║   • outputs: JSON des résultats (assets, métadonnées)                      ║
-- ╚═════════════════════════════════════════════════════════════════════════════╝
CREATE TABLE public.v2_workflow_runs (
  run_id uuid NOT NULL DEFAULT gen_random_uuid(),
  workflow_id text NOT NULL,  -- ID du workflow YAML (ex: "simple-image-v1")
  workflow_version text NOT NULL,  -- Version du workflow (ex: "1.0.0")
  user_id uuid,
  status text NOT NULL 
    CHECK (status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text])),
  input jsonb NOT NULL,  -- { prompt: "...", model: "...", source_asset: {...} }
  execution_plan jsonb NOT NULL,  -- ExecutionGraph compilé
  outputs jsonb,  -- { main_asset: [...], edit_context: {...} }
  error jsonb,  -- { code: "...", message: "..." }
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  completed_at timestamp with time zone,
  
  CONSTRAINT v2_workflow_runs_pkey PRIMARY KEY (run_id),
  CONSTRAINT v2_workflow_runs_user_id_fkey 
    FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL
);

COMMENT ON COLUMN public.v2_workflow_runs.input IS 'Inputs utilisateur (prompt, source_asset, etc.)';
COMMENT ON COLUMN public.v2_workflow_runs.execution_plan IS 'ExecutionGraph: nodes, edges, bindings compilés';
COMMENT ON COLUMN public.v2_workflow_runs.outputs IS 'Résultats: assets générés, métadonnées';

-- ╔═════════════════════════════════════════════════════════════════════════════╗
-- ║ TABLE: v2_workflow_run_nodes                                                ║
-- ║ Description: Statut d exécution de chaque node.                            ║
-- ║                                                                             ║
-- ║ PK composite: (run_id, node_id)                                             ║
-- ╚═════════════════════════════════════════════════════════════════════════════╝
CREATE TABLE public.v2_workflow_run_nodes (
  run_id uuid NOT NULL,
  node_id text NOT NULL,  -- ID du node dans le graphe (ex: "generate", "build_prompt")
  node_type text NOT NULL,  -- Type: "prompt-builder", "image-generation", "media-transform"
  status text NOT NULL 
    CHECK (status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text])),
  attempt integer NOT NULL DEFAULT 1,  -- Numéro de tentative (retry)
  output jsonb,  -- Résultat du node (ex: { assets: [...] } pour image-generation)
  error jsonb,  -- { message: "...", stack: "..." }
  started_at timestamp with time zone,
  completed_at timestamp with time zone,
  provider_override text,  -- Provider utilisé si fallback (ex: "fal" → "replicate")
  
  CONSTRAINT v2_workflow_run_nodes_pkey PRIMARY KEY (run_id, node_id),
  CONSTRAINT v2_workflow_run_nodes_run_id_fkey 
    FOREIGN KEY (run_id) REFERENCES public.v2_workflow_runs(run_id) ON DELETE CASCADE
);

COMMENT ON COLUMN public.v2_workflow_run_nodes.attempt IS 'Numéro de retry (1 = première tentative)';
COMMENT ON COLUMN public.v2_workflow_run_nodes.provider_override IS 'Provider utilisé si fallback suite à échec';

-- ┌─────────────────────────────────────────────────────────────────────────────┐
-- │ 7. TABLES UTILITAIRES                                                       │
-- └─────────────────────────────────────────────────────────────────────────────┘

-- ╔═════════════════════════════════════════════════════════════════════════════╗
-- ║ TABLE: provider_calls                                                       ║
-- ║ Description: Log des appels aux providers (Fal, Replicate, etc.)            ║
-- ║ Utilisé pour: debugging, billing, retry idempotent                         ║
-- ╚═════════════════════════════════════════════════════════════════════════════╝
CREATE TABLE public.provider_calls (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  provider_name text NOT NULL,
  idempotency_key text NOT NULL,  -- v2:run_id:node_id:attempt
  status text NOT NULL,  -- "success", "error", "timeout"
  provider_request_id text,  -- ID retourné par le provider
  response jsonb,  -- Réponse du provider
  error text,  -- Message d erreur
  meta jsonb,  -- { latencyMs, cost, model }
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  
  CONSTRAINT provider_calls_pkey PRIMARY KEY (id)
);

-- ┌─────────────────────────────────────────────────────────────────────────────┐
-- │ INDEXES (Performance)                                                       │
-- └─────────────────────────────────────────────────────────────────────────────┘

CREATE INDEX idx_media_workflow ON public.media(workflow_id);
CREATE INDEX idx_media_project ON public.media(project_id);
CREATE INDEX idx_media_create_time ON public.media(create_time DESC);
CREATE INDEX idx_workflow_project ON public.workflow(project_id);
CREATE INDEX idx_workflow_session ON public.workflow(session_id);
CREATE INDEX idx_session_project ON public.session(project_id);
CREATE INDEX idx_v2_runs_user ON public.v2_workflow_runs(user_id);
CREATE INDEX idx_v2_runs_status ON public.v2_workflow_runs(status);
CREATE INDEX idx_v2_runs_created ON public.v2_workflow_runs(created_at DESC);
CREATE INDEX idx_v2_nodes_run ON public.v2_workflow_run_nodes(run_id);
CREATE INDEX idx_transactions_wallet ON public.transactions(wallet_id);
CREATE INDEX idx_transactions_status ON public.transactions(status);
CREATE INDEX idx_provider_calls_key ON public.provider_calls(idempotency_key);

-- ┌─────────────────────────────────────────────────────────────────────────────┐
-- │ ROW LEVEL SECURITY (RLS) - Supabase                                         │
-- └─────────────────────────────────────────────────────────────────────────────┘

ALTER TABLE public.project ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.generation_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.v2_workflow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.v2_workflow_run_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Policy: Users can only see their own data
CREATE POLICY "project_owner" ON public.project
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY "session_owner" ON public.session
  FOR ALL USING (project_id IN (
    SELECT id FROM public.project WHERE user_id = auth.uid()
  ));

CREATE POLICY "workflow_owner" ON public.workflow
  FOR ALL USING (project_id IN (
    SELECT id FROM public.project WHERE user_id = auth.uid()
  ));

CREATE POLICY "media_owner" ON public.media
  FOR ALL USING (project_id IN (
    SELECT id FROM public.project WHERE user_id = auth.uid()
  ));

CREATE POLICY "v2_run_owner" ON public.v2_workflow_runs
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY "wallet_owner" ON public.wallets
  FOR ALL USING (user_id = auth.uid());

CREATE POLICY "transaction_owner" ON public.transactions
  FOR ALL USING (wallet_id IN (
    SELECT id FROM public.wallets WHERE user_id = auth.uid()
  ));

-- ┌─────────────────────────────────────────────────────────────────────────────┐
-- │ DIAGRAMME RELATIONNEL (ASCII)                                               │
-- └─────────────────────────────────────────────────────────────────────────────┘

/*

auth.users
    │
    ├──► profiles (1:1)
    │
    ├──► wallets (1:1)
    │       │
    │       └──► transactions (1:N)
    │
    ├──► project (1:N)
    │       │
    │       ├──► session (1:N)
    │       │       │
    │       │       └──► workflow (1:N)
    │       │               │
    │       │               ├──► media (1:N) ◄────┐
    │       │               │       ▲             │
    │       │               │       └─────────────┘
    │       │               │       (workflow.primary_media_id)
    │       │               │
    │       │               └──► generation_config (N:1)
    │       │                       │
    │       │                       └──► generation_config_reference (1:N)
    │       │                               │
    │       │                               └──► media (ref_media_id)
    │       │
    │       └──► batch (1:N)
    │               │
    │               └──► generation_config (1:1)
    │
    └──► v2_workflow_runs (1:N)
            │
            └──► v2_workflow_run_nodes (1:N)


┌──────────────────────────────────────────────────────────────────────────────┐
│  EXEMPLE DE DONNÉES (Generate vs Edit)                                       │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  GENERATE:                                                                   │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                      │
│  │ workflow    │───►│ media_100   │    │             │                      │
│  │ id: wf_123  │    │ step: GEN   │    │             │                      │
│  │ type: GEN   │    │ url: cat.png│    │             │                      │
│  └─────────────┘    └─────────────┘    │             │                      │
│                                        │             │                      │
│  EDIT:                                                                   │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐                      │
│  │ workflow    │───►│ media_100   │    │             │                      │
│  │ id: wf_123  │    │ step: GEN   │    │  (primary   │                      │
│  │ type: GEN   │    │ url: cat.png│    │   remplacé) │                      │
│  │ primary:    │    └─────────────┘    │             │                      │
│  │   media_102 │                       │             │                      │
│  └─────────────┘    ┌─────────────┐    │             │                      │
│                     │ media_101   │    │             │                      │
│                     │ step: EDIT  │────┘             │                      │
│                     │ url: no-bg  │                  │                      │
│                     └─────────────┘                  │                      │
│                                                      │                      │
│                     ┌─────────────┐                  │                      │
│                     │ media_102   │◄─────────────────┘                      │
│                     │ step: EDIT  │  (NOUVEAU primary)                       │
│                     │ url: anime  │                                          │
│                     └─────────────┘                                          │
│                                                                              │
│  NOTE: L historique est retrouvé via:                                        │
│        SELECT * FROM media WHERE workflow_id = 'wf_123' ORDER BY create_time │
│                                                                              │
└──────────────────────────────────────────────────────────────────────────────┘

*/

-- ╔═════════════════════════════════════════════════════════════════════════════╗
-- ║ TABLE: characters                                                           ║
-- ║ Description: Character entities with turnaround URLs, traits and metadata   ║
-- ╚═════════════════════════════════════════════════════════════════════════════╝
CREATE TABLE public.characters (
  id uuid NOT NULL DEFAULT gen_random_uuid (),
  user_id uuid NOT NULL,
  project_id uuid NULL,
  workflow_id uuid NULL,
  name character varying(255) NOT NULL,
  title character varying(255) NULL,
  description text NULL,
  character_info text NULL,
  archetype character varying(100) NULL,
  gender character varying(50) NULL,
  style character varying(100) NULL DEFAULT 'cinematic'::character varying,
  traits jsonb NULL DEFAULT '{}'::jsonb,
  keywords text[] NULL DEFAULT '{}'::text[],
  guidelines text[] NULL DEFAULT '{}'::text[],
  avatar_url text NULL,
  turnaround_url text NULL,
  reference_images text[] NULL DEFAULT '{}'::text[],
  is_favorited boolean NULL DEFAULT false,
  status character varying(50) NULL DEFAULT 'ready'::character varying,
  created_at timestamp with time zone NULL DEFAULT now(),
  updated_at timestamp with time zone NULL DEFAULT now(),
  CONSTRAINT characters_pkey PRIMARY KEY (id),
  CONSTRAINT characters_project_id_fkey FOREIGN KEY (project_id) REFERENCES project (id) ON DELETE CASCADE,
  CONSTRAINT characters_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE CASCADE,
  CONSTRAINT characters_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES workflow (id) ON DELETE SET NULL
) TABLESPACE pg_default;

CREATE INDEX IF NOT EXISTS idx_characters_user_id ON public.characters USING btree (user_id) TABLESPACE pg_default;
CREATE INDEX IF NOT EXISTS idx_characters_project_id ON public.characters USING btree (project_id) TABLESPACE pg_default;

