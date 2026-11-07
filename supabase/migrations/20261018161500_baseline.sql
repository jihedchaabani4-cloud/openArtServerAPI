--
-- PostgreSQL database dump
--

-- \restrict iLUaO0qjAdyzB39hPDZbvX7J1dgFdeyhp9oHkU86XRPlfL8uBGXqxVo4tdMU1En

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS "public";


--
-- Name: SCHEMA "public"; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA "public" IS 'standard public schema';


--
-- Name: transaction_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."transaction_status" AS ENUM (
    'PENDING',
    'COMPLETED',
    'FAILED'
);


--
-- Name: transaction_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."transaction_type" AS ENUM (
    'DEBIT',
    'CREDIT'
);


--
-- Name: workflow_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE "public"."workflow_type" AS ENUM (
    'GENERATION',
    'ELEMENT_SHEET'
);


--
-- Name: commit_transaction("text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."commit_transaction"("p_reference_id" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_transaction RECORD;
BEGIN
  SELECT * INTO v_transaction FROM transactions WHERE reference_id = p_reference_id FOR UPDATE;
  
  IF v_transaction IS NULL THEN
    RAISE EXCEPTION 'Transaction % not found', p_reference_id;
  END IF;

  IF v_transaction.status != 'PENDING' THEN
    RAISE EXCEPTION 'Transaction is not PENDING (current status: %)', v_transaction.status;
  END IF;

  UPDATE transactions SET status = 'COMPLETED' WHERE id = v_transaction.id RETURNING * INTO v_transaction;

  RETURN row_to_json(v_transaction)::jsonb;
END;
$$;


--
-- Name: create_workflow_with_placeholder_media("uuid", "uuid", "text", "text", "uuid", "text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."create_workflow_with_placeholder_media"("p_project_id" "uuid", "p_session_id" "uuid" DEFAULT NULL::"uuid", "p_display_name" "text" DEFAULT 'Untitled'::"text", "p_workflow_type" "text" DEFAULT 'GENERATION'::"text", "p_generation_config_id" "uuid" DEFAULT NULL::"uuid", "p_step_id" "text" DEFAULT 'GEN'::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
    v_workflow_id UUID;
    v_media_id    UUID;
BEGIN
    -- 1. Insert Workflow row
    INSERT INTO workflow (project_id, session_id, display_name, workflow_type)
    VALUES (p_project_id, p_session_id, p_display_name, p_workflow_type)
    RETURNING id INTO v_workflow_id;
    -- 2. Insert Media placeholder row (url = NULL, status = 'processing')
    INSERT INTO media (
        project_id,
        workflow_id,
        generation_config_id,
        step_id,
        status,
        url,
        width,
        height
    )
    VALUES (
        p_project_id,
        v_workflow_id,
        p_generation_config_id,
        p_step_id,
        'processing',
        NULL,
        1024,
        1024
    )
    RETURNING id INTO v_media_id;
    -- 3. Link the media as primary media on the workflow
    UPDATE workflow
    SET primary_media_id = v_media_id
    WHERE id = v_workflow_id;
    -- 4. Return both IDs to the caller
    RETURN jsonb_build_object(
        'workflow_id', v_workflow_id,
        'media_id',    v_media_id
    );
EXCEPTION
    WHEN OTHERS THEN
        -- Any error rolls back all changes automatically (plpgsql default)
        RAISE;
END;
$$;


--
-- Name: credit_wallet("uuid", numeric, "text", "jsonb"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."credit_wallet"("p_wallet_id" "uuid", "p_amount" numeric, "p_reference_id" "text", "p_metadata" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_transaction RECORD;
BEGIN
  -- 1. Check duplicate
  IF EXISTS (SELECT 1 FROM transactions WHERE reference_id = p_reference_id) THEN
    RAISE EXCEPTION 'Transaction % already exists', p_reference_id USING ERRCODE = '23505';
  END IF;

  -- 2. Update wallet balance
  UPDATE wallets SET balance = balance + p_amount WHERE id = p_wallet_id;

  -- 3. Insert transaction
  INSERT INTO transactions (
    wallet_id, amount, type, status, reference_id, metadata
  ) VALUES (
    p_wallet_id, p_amount, 'CREDIT', 'COMPLETED', p_reference_id, p_metadata
  ) RETURNING * INTO v_transaction;

  RETURN row_to_json(v_transaction)::jsonb;
END;
$$;


--
-- Name: hold_credits("uuid", numeric, "text", "jsonb", timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."hold_credits"("p_wallet_id" "uuid", "p_amount" numeric, "p_reference_id" "text", "p_metadata" "jsonb", "p_expires_at" timestamp with time zone) RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_balance NUMERIC;
  v_transaction RECORD;
BEGIN
  -- 1. Check if transaction already exists
  IF EXISTS (SELECT 1 FROM transactions WHERE reference_id = p_reference_id) THEN
    RAISE EXCEPTION 'Transaction % already exists', p_reference_id USING ERRCODE = '23505';
  END IF;

  -- 2. Lock the wallet row and get balance
  SELECT balance INTO v_balance FROM wallets WHERE id = p_wallet_id FOR UPDATE;
  
  IF v_balance IS NULL THEN
    RAISE EXCEPTION 'Wallet % not found', p_wallet_id;
  END IF;

  IF v_balance < p_amount THEN
    RAISE EXCEPTION 'Insufficient funds: need %, have %', p_amount, v_balance;
  END IF;

  -- 3. Deduct balance
  UPDATE wallets SET balance = balance - p_amount WHERE id = p_wallet_id;

  -- 4. Create pending transaction
  INSERT INTO transactions (
    wallet_id, amount, type, status, reference_id, metadata, expires_at
  ) VALUES (
    p_wallet_id, p_amount, 'DEBIT', 'PENDING', p_reference_id, p_metadata, p_expires_at
  ) RETURNING * INTO v_transaction;

  RETURN row_to_json(v_transaction)::jsonb;
END;
$$;


--
-- Name: rollback_transaction("text"); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."rollback_transaction"("p_reference_id" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_transaction RECORD;
BEGIN
  SELECT * INTO v_transaction FROM transactions WHERE reference_id = p_reference_id FOR UPDATE;
  
  IF v_transaction IS NULL THEN
    RAISE EXCEPTION 'Transaction % not found', p_reference_id;
  END IF;

  IF v_transaction.status != 'PENDING' THEN
    RAISE EXCEPTION 'Transaction is not PENDING (current status: %)', v_transaction.status;
  END IF;

  -- Refund the wallet
  UPDATE wallets SET balance = balance + v_transaction.amount WHERE id = v_transaction.wallet_id;

  -- Mark as FAILED
  UPDATE transactions SET status = 'FAILED' WHERE id = v_transaction.id RETURNING * INTO v_transaction;

  RETURN row_to_json(v_transaction)::jsonb;
END;
$$;


--
-- Name: update_credit_packages_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."update_credit_packages_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


--
-- Name: update_usage_events_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION "public"."update_usage_events_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = "heap";

--
-- Name: characters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."characters" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "project_id" "uuid",
    "workflow_id" "uuid",
    "name" character varying(255) NOT NULL,
    "title" character varying(255),
    "description" "text",
    "archetype" character varying(100),
    "gender" character varying(50),
    "style" character varying(100) DEFAULT 'cinematic'::character varying,
    "traits" "jsonb" DEFAULT '{}'::"jsonb",
    "keywords" "text"[] DEFAULT '{}'::"text"[],
    "guidelines" "text"[] DEFAULT '{}'::"text"[],
    "avatar_url" "text",
    "turnaround_url" "text",
    "reference_images" "text"[] DEFAULT '{}'::"text"[],
    "is_favorited" boolean DEFAULT false,
    "status" character varying(50) DEFAULT 'ready'::character varying,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "character_info" "text"
);


--
-- Name: credit_packages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."credit_packages" (
    "id" "text" NOT NULL,
    "label" "text" NOT NULL,
    "credits" integer NOT NULL,
    "price" numeric(10,2) NOT NULL,
    "currency" "text" DEFAULT 'USD'::"text" NOT NULL,
    "yearly_price" numeric(10,2),
    "variant_id" "text",
    "checkout_url" "text",
    "popular" boolean DEFAULT false,
    "is_trial" boolean DEFAULT false,
    "is_active" boolean DEFAULT true,
    "sort_order" integer DEFAULT 0,
    "description" "text",
    "features" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "plan_type" "text",
    CONSTRAINT "credit_packages_plan_type_check" CHECK (("plan_type" = ANY (ARRAY['subscription'::"text", 'one-time'::"text"])))
);


--
-- Name: element; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."element" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "workflow_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "source_images" "jsonb" DEFAULT '[]'::"jsonb",
    "create_time" timestamp with time zone DEFAULT "now"(),
    "element_type" "text" DEFAULT 'object'::"text",
    "guidelines" "text" DEFAULT ''::"text" NOT NULL
);


--
-- Name: folders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."folders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "parent_id" "uuid",
    "name" "text" NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


--
-- Name: generation_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."generation_config" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "prompt" "text" NOT NULL,
    "model" "text" NOT NULL,
    "aspect_ratio" "text" NOT NULL,
    "generation_type" "text" NOT NULL,
    "seed" bigint,
    "visibility" "text" DEFAULT 'PRIVATE'::"text" NOT NULL,
    "prompt_optimise" "text",
    CONSTRAINT "generation_config_visibility_check" CHECK (("visibility" = ANY (ARRAY['PRIVATE'::"text", 'PUBLIC'::"text"])))
);


--
-- Name: TABLE "generation_config"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."generation_config" IS 'params التوليد — يستخدمها batch وmedia معاً';


--
-- Name: COLUMN "generation_config"."generation_type"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."generation_config"."generation_type" IS 'TEXT_ONLY | TEXT_BASE_IMAGE | TEXT_REFERENCES | TEXT_BASE_IMAGE_REFERENCES | UPLOAD';


--
-- Name: COLUMN "generation_config"."seed"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."generation_config"."seed" IS 'NULL في batch (مشترك)، موجود في كل media على حدة';


--
-- Name: media; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."media" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "generation_config_id" "uuid",
    "step_id" "text" NOT NULL,
    "url" "text",
    "width" integer NOT NULL,
    "height" integer NOT NULL,
    "create_time" timestamp with time zone DEFAULT "now"() NOT NULL,
    "status" "text" DEFAULT 'processing'::"text",
    "error_message" "text",
    CONSTRAINT "media_height_check" CHECK (("height" > 0)),
    CONSTRAINT "media_width_check" CHECK (("width" > 0))
);


--
-- Name: TABLE "media"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."media" IS 'صورة واحدة — init أو edit أو upload داخل workflow';


--
-- Name: COLUMN "media"."step_id"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."media"."step_id" IS 'CAE=init/upload, CAM/CAU/CAc/...=edit steps بالترتيب';


--
-- Name: COLUMN "media"."url"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."media"."url" IS 'رابط الملف المباشر في Supabase Storage';


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."profiles" (
    "id" "uuid" NOT NULL,
    "email" "text",
    "full_name" "text",
    "avatar_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "credits" integer DEFAULT 0
);


--
-- Name: project; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."project" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_name" "text" NOT NULL,
    "create_time" timestamp with time zone DEFAULT "now"() NOT NULL,
    "user_id" "uuid"
);


--
-- Name: provider_calls; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."provider_calls" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider_name" "text" NOT NULL,
    "idempotency_key" "text" NOT NULL,
    "status" "text" NOT NULL,
    "provider_request_id" "text",
    "response" "jsonb",
    "error" "text",
    "meta" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."transactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "wallet_id" "uuid" NOT NULL,
    "amount" numeric(15,2) NOT NULL,
    "type" "public"."transaction_type" NOT NULL,
    "status" "public"."transaction_status" DEFAULT 'PENDING'::"public"."transaction_status",
    "reference_id" character varying(255) NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "expires_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


--
-- Name: usage_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."usage_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "reference_id" "text" NOT NULL,
    "kind" "text" DEFAULT 'free_model_usage'::"text" NOT NULL,
    "status" "text" DEFAULT 'ACTIVE'::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "usage_events_status_check" CHECK (("status" = ANY (ARRAY['ACTIVE'::"text", 'COMPLETED'::"text", 'RELEASED'::"text"])))
);


--
-- Name: v2_workflow_run_nodes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."v2_workflow_run_nodes" (
    "run_id" "uuid" NOT NULL,
    "node_id" "text" NOT NULL,
    "node_type" "text" NOT NULL,
    "status" "text" NOT NULL,
    "attempt" integer DEFAULT 1 NOT NULL,
    "output" "jsonb",
    "error" "jsonb",
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "provider_override" "text",
    CONSTRAINT "v2_workflow_run_nodes_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'running'::"text", 'completed'::"text", 'failed'::"text"])))
);


--
-- Name: v2_workflow_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."v2_workflow_runs" (
    "run_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "workflow_id" "text" NOT NULL,
    "workflow_version" "text" NOT NULL,
    "user_id" "uuid",
    "status" "text" NOT NULL,
    "input" "jsonb" NOT NULL,
    "execution_plan" "jsonb" NOT NULL,
    "outputs" "jsonb",
    "error" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    "target_workflow_id" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "v1_workflow_id" "uuid",
    "target_media_ids" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    CONSTRAINT "v2_workflow_runs_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'running'::"text", 'completed'::"text", 'failed'::"text"])))
);


--
-- Name: COLUMN "v2_workflow_runs"."metadata"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."v2_workflow_runs"."metadata" IS 'Run-level metadata, including persisted billing accumulator entries.';


--
-- Name: COLUMN "v2_workflow_runs"."v1_workflow_id"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."v2_workflow_runs"."v1_workflow_id" IS 'References the V1 workflow table row (public.workflow.id).';


--
-- Name: COLUMN "v2_workflow_runs"."target_media_ids"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."v2_workflow_runs"."target_media_ids" IS 'JSON array of pre-allocated media IDs authorized for finalization.';


--
-- Name: wallets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."wallets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "balance" numeric(15,2) DEFAULT 0.00,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "wallets_balance_check" CHECK (("balance" >= (0)::numeric))
);


--
-- Name: workflow; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."workflow" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "project_id" "uuid" NOT NULL,
    "session_id" "uuid",
    "display_name" "text" NOT NULL,
    "variation_index" smallint,
    "primary_media_id" "uuid",
    "create_time" timestamp with time zone DEFAULT "now"() NOT NULL,
    "favorited" boolean DEFAULT false,
    "workflow_type" "text" DEFAULT 'GENERATION'::"text" NOT NULL,
    "folder_id" "uuid",
    "user_id" "uuid",
    CONSTRAINT "workflow_variation_index_check" CHECK (("variation_index" >= 0)),
    CONSTRAINT "workflow_workflow_type_check" CHECK (("workflow_type" = ANY (ARRAY['GENERATION'::"text", 'UPLOAD'::"text", 'ELEMENT_SHEET'::"text", 'CHARACTER'::"text", 'CHARACTER_SHEET'::"text"])))
);


--
-- Name: TABLE "workflow"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE "public"."workflow" IS 'variation واحدة — تحتوي على سلسلة media (init + edits)';


--
-- Name: COLUMN "workflow"."session_id"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."workflow"."session_id" IS 'الجلسة التي ينتمي إليها هذا الـ workflow';


--
-- Name: COLUMN "workflow"."variation_index"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."workflow"."variation_index" IS '0-based index داخل الـ batch — NULL إذا workflow منفرد';


--
-- Name: COLUMN "workflow"."primary_media_id"; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN "public"."workflow"."primary_media_id" IS 'آخر صورة نشطة يشوفها المستخدم';


--
-- Name: workflow_media; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE "public"."workflow_media" (
    "workflow_id" "uuid" NOT NULL,
    "media_id" "uuid" NOT NULL,
    "role" "text" DEFAULT 'output'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "workflow_media_role_check" CHECK (("role" = ANY (ARRAY['output'::"text", 'original'::"text", 'sheet'::"text", 'detail'::"text", 'reference'::"text", 'avatar'::"text", 'turnaround'::"text"])))
);


--
-- Name: characters characters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."characters"
    ADD CONSTRAINT "characters_pkey" PRIMARY KEY ("id");


--
-- Name: credit_packages credit_packages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."credit_packages"
    ADD CONSTRAINT "credit_packages_pkey" PRIMARY KEY ("id");


--
-- Name: element element_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."element"
    ADD CONSTRAINT "element_pkey" PRIMARY KEY ("id");


--
-- Name: folders folders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."folders"
    ADD CONSTRAINT "folders_pkey" PRIMARY KEY ("id");


--
-- Name: folders folders_project_folder_uq; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."folders"
    ADD CONSTRAINT "folders_project_folder_uq" UNIQUE ("id", "project_id");


--
-- Name: generation_config generation_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."generation_config"
    ADD CONSTRAINT "generation_config_pkey" PRIMARY KEY ("id");


--
-- Name: media media_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."media"
    ADD CONSTRAINT "media_pkey" PRIMARY KEY ("id");


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");


--
-- Name: project project_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."project"
    ADD CONSTRAINT "project_pkey" PRIMARY KEY ("id");


--
-- Name: provider_calls provider_calls_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."provider_calls"
    ADD CONSTRAINT "provider_calls_pkey" PRIMARY KEY ("id");


--
-- Name: provider_calls provider_calls_provider_name_idempotency_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."provider_calls"
    ADD CONSTRAINT "provider_calls_provider_name_idempotency_key_key" UNIQUE ("provider_name", "idempotency_key");


--
-- Name: transactions transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_pkey" PRIMARY KEY ("id");


--
-- Name: transactions transactions_reference_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_reference_id_key" UNIQUE ("reference_id");


--
-- Name: usage_events usage_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_events"
    ADD CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id");


--
-- Name: usage_events usage_events_reference_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_events"
    ADD CONSTRAINT "usage_events_reference_id_key" UNIQUE ("reference_id");


--
-- Name: v2_workflow_run_nodes v2_workflow_run_nodes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."v2_workflow_run_nodes"
    ADD CONSTRAINT "v2_workflow_run_nodes_pkey" PRIMARY KEY ("run_id", "node_id");


--
-- Name: v2_workflow_runs v2_workflow_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."v2_workflow_runs"
    ADD CONSTRAINT "v2_workflow_runs_pkey" PRIMARY KEY ("run_id");


--
-- Name: wallets wallets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."wallets"
    ADD CONSTRAINT "wallets_pkey" PRIMARY KEY ("id");


--
-- Name: wallets wallets_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."wallets"
    ADD CONSTRAINT "wallets_user_id_key" UNIQUE ("user_id");


--
-- Name: workflow_media workflow_media_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workflow_media"
    ADD CONSTRAINT "workflow_media_pkey" PRIMARY KEY ("workflow_id", "media_id", "role");


--
-- Name: workflow workflow_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workflow"
    ADD CONSTRAINT "workflow_pkey" PRIMARY KEY ("id");


--
-- Name: folders_project_parent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "folders_project_parent_idx" ON "public"."folders" USING "btree" ("project_id", "parent_id", "position");


--
-- Name: folders_sibling_name_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX "folders_sibling_name_uq" ON "public"."folders" USING "btree" ("project_id", COALESCE("parent_id", '00000000-0000-0000-0000-000000000000'::"uuid"), "lower"("name"));


--
-- Name: idx_characters_project_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_characters_project_id" ON "public"."characters" USING "btree" ("project_id");


--
-- Name: idx_characters_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_characters_user_id" ON "public"."characters" USING "btree" ("user_id");


--
-- Name: idx_media_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_media_project" ON "public"."media" USING "btree" ("project_id");


--
-- Name: idx_transactions_reference_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_transactions_reference_id" ON "public"."transactions" USING "btree" ("reference_id");


--
-- Name: idx_transactions_status_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_transactions_status_expires" ON "public"."transactions" USING "btree" ("status", "expires_at");


--
-- Name: idx_usage_events_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_usage_events_created_at" ON "public"."usage_events" USING "btree" ("created_at" DESC);


--
-- Name: idx_usage_events_reference_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_usage_events_reference_id" ON "public"."usage_events" USING "btree" ("reference_id");


--
-- Name: idx_usage_events_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_usage_events_status" ON "public"."usage_events" USING "btree" ("status");


--
-- Name: idx_usage_events_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_usage_events_user_id" ON "public"."usage_events" USING "btree" ("user_id");


--
-- Name: idx_v2_workflow_runs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_v2_workflow_runs_status" ON "public"."v2_workflow_runs" USING "btree" ("run_id", "status");


--
-- Name: idx_v2_workflow_runs_target_workflow; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_v2_workflow_runs_target_workflow" ON "public"."v2_workflow_runs" USING "btree" ("target_workflow_id") WHERE ("target_workflow_id" IS NOT NULL);


--
-- Name: idx_v2_workflow_runs_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_v2_workflow_runs_user_created" ON "public"."v2_workflow_runs" USING "btree" ("user_id", "created_at" DESC);


--
-- Name: idx_v2_workflow_runs_v1_workflow_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_v2_workflow_runs_v1_workflow_id" ON "public"."v2_workflow_runs" USING "btree" ("v1_workflow_id") WHERE ("v1_workflow_id" IS NOT NULL);


--
-- Name: idx_workflow_project; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_workflow_project" ON "public"."workflow" USING "btree" ("project_id");


--
-- Name: idx_workflow_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_workflow_session" ON "public"."workflow" USING "btree" ("session_id");


--
-- Name: idx_workflow_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "idx_workflow_user_id" ON "public"."workflow" USING "btree" ("user_id") WHERE ("user_id" IS NOT NULL);


--
-- Name: workflow_media_media_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "workflow_media_media_id_idx" ON "public"."workflow_media" USING "btree" ("media_id");


--
-- Name: workflow_media_role_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "workflow_media_role_idx" ON "public"."workflow_media" USING "btree" ("role");


--
-- Name: workflow_media_workflow_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "workflow_media_workflow_id_idx" ON "public"."workflow_media" USING "btree" ("workflow_id", "created_at");


--
-- Name: workflow_project_folder_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX "workflow_project_folder_idx" ON "public"."workflow" USING "btree" ("project_id", "folder_id", "create_time" DESC);


--
-- Name: credit_packages credit_packages_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "credit_packages_updated_at" BEFORE UPDATE ON "public"."credit_packages" FOR EACH ROW EXECUTE FUNCTION "public"."update_credit_packages_updated_at"();


--
-- Name: usage_events trg_usage_events_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "trg_usage_events_updated_at" BEFORE UPDATE ON "public"."usage_events" FOR EACH ROW EXECUTE FUNCTION "public"."update_usage_events_updated_at"();


--
-- Name: transactions update_transactions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_transactions_updated_at" BEFORE UPDATE ON "public"."transactions" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: wallets update_wallets_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "update_wallets_updated_at" BEFORE UPDATE ON "public"."wallets" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();


--
-- Name: characters characters_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."characters"
    ADD CONSTRAINT "characters_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE CASCADE;


--
-- Name: characters characters_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."characters"
    ADD CONSTRAINT "characters_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;


--
-- Name: characters characters_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."characters"
    ADD CONSTRAINT "characters_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow"("id") ON DELETE SET NULL;


--
-- Name: element element_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."element"
    ADD CONSTRAINT "element_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow"("id") ON DELETE SET NULL;


--
-- Name: wallets fk_wallets_user; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."wallets"
    ADD CONSTRAINT "fk_wallets_user" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;


--
-- Name: workflow fk_workflow_primary_media; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workflow"
    ADD CONSTRAINT "fk_workflow_primary_media" FOREIGN KEY ("primary_media_id") REFERENCES "public"."media"("id") ON DELETE SET NULL;


--
-- Name: folders folders_parent_same_project_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."folders"
    ADD CONSTRAINT "folders_parent_same_project_fk" FOREIGN KEY ("parent_id", "project_id") REFERENCES "public"."folders"("id", "project_id");


--
-- Name: folders folders_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."folders"
    ADD CONSTRAINT "folders_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE CASCADE;


--
-- Name: media media_generation_config_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."media"
    ADD CONSTRAINT "media_generation_config_id_fkey" FOREIGN KEY ("generation_config_id") REFERENCES "public"."generation_config"("id");


--
-- Name: media media_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."media"
    ADD CONSTRAINT "media_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE CASCADE;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_id_fkey" FOREIGN KEY ("id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;


--
-- Name: transactions transactions_wallet_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."transactions"
    ADD CONSTRAINT "transactions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "public"."wallets"("id") ON DELETE CASCADE;


--
-- Name: usage_events usage_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."usage_events"
    ADD CONSTRAINT "usage_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;


--
-- Name: v2_workflow_run_nodes v2_workflow_run_nodes_run_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."v2_workflow_run_nodes"
    ADD CONSTRAINT "v2_workflow_run_nodes_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."v2_workflow_runs"("run_id") ON DELETE CASCADE;


--
-- Name: v2_workflow_runs v2_workflow_runs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."v2_workflow_runs"
    ADD CONSTRAINT "v2_workflow_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;


--
-- Name: workflow workflow_folder_same_project_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workflow"
    ADD CONSTRAINT "workflow_folder_same_project_fk" FOREIGN KEY ("folder_id", "project_id") REFERENCES "public"."folders"("id", "project_id");


--
-- Name: workflow_media workflow_media_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workflow_media"
    ADD CONSTRAINT "workflow_media_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE CASCADE;


--
-- Name: workflow_media workflow_media_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workflow_media"
    ADD CONSTRAINT "workflow_media_workflow_id_fkey" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflow"("id") ON DELETE CASCADE;


--
-- Name: workflow workflow_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY "public"."workflow"
    ADD CONSTRAINT "workflow_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE CASCADE;


--
-- Name: credit_packages Public read active packages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public read active packages" ON "public"."credit_packages" FOR SELECT USING (("is_active" = true));


--
-- Name: wallets Service role can manage wallets; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage wallets" ON "public"."wallets" USING (true) WITH CHECK (true);


--
-- Name: wallets Users can view their own wallet; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own wallet" ON "public"."wallets" FOR SELECT USING (("auth"."uid"() = "user_id"));


--
-- Name: characters; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."characters" ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_packages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."credit_packages" ENABLE ROW LEVEL SECURITY;

--
-- Name: folders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."folders" ENABLE ROW LEVEL SECURITY;

--
-- Name: folders folders_owner; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "folders_owner" ON "public"."folders" USING (("user_id" = "auth"."uid"()));


--
-- Name: provider_calls; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."provider_calls" ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."usage_events" ENABLE ROW LEVEL SECURITY;

--
-- Name: usage_events usage_events_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "usage_events_select_own" ON "public"."usage_events" FOR SELECT USING (("auth"."uid"() = "user_id"));


--
-- Name: v2_workflow_run_nodes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."v2_workflow_run_nodes" ENABLE ROW LEVEL SECURITY;

--
-- Name: v2_workflow_runs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."v2_workflow_runs" ENABLE ROW LEVEL SECURITY;

--
-- Name: wallets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."wallets" ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_media; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE "public"."workflow_media" ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

-- \unrestrict iLUaO0qjAdyzB39hPDZbvX7J1dgFdeyhp9oHkU86XRPlfL8uBGXqxVo4tdMU1En

