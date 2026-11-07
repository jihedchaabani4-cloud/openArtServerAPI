# OpenArt Wallet System — Full Server Architecture Analysis

> **Projet** : OpenArt API (`apiOpenArt`)  
> **Stack** : Node.js ESM, Express 4, Supabase PostgreSQL, BullMQ, Lemon Squeezy  
> **Date d'analyse** : Juin 2026  
> **Feature** : Système de crédits (wallet) pour génération d'images et vidéos IA

---

## Table des matières

1. [Vue d'ensemble](#1-vue-densemble)
2. [Schéma de base de données](#2-schéma-de-base-de-données)
3. [WalletService — Moteur central](#3-walletservice--moteur-central)
4. [Mécanisme Hold / Commit / Rollback](#4-mécanisme-hold--commit--rollback)
5. [Intégration avec les générations (Treatments)](#5-intégration-avec-les-générations-treatments)
6. [Système de paiement (Lemon Squeezy)](#6-système-de-paiement-lemon-squeezy)
7. [Gestion des race conditions et sécurité](#7-gestion-des-race-conditions-et-sécurité)
8. [Architecture de dépendances (Container)](#8-architecture-de-dépendances-container)
9. [Points forts et axes d'amélioration](#9-points-forts-et-axes-damélioration)
10. [Diagramme de flux complet](#10-diagramme-de-flux-complet)

---

## 1. Vue d'ensemble

Le système de wallet d'OpenArt est un **système de crédits prépayés** utilisé pour facturer les générations d'images et de vidéos IA. Chaque utilisateur dispose d'un portefeuille virtuel (`wallets`) stocké dans Supabase PostgreSQL. Les crédits sont consommés **atomiquement** via un mécanisme en trois phases :

| Phase | Action | État transaction |
|-------|--------|------------------|
| **Hold** | Déduire les crédits immédiatement | `PENDING` |
| **Commit** | Confirmer la consommation | `PENDING` → `COMPLETED` |
| **Rollback** | Rembourser en cas d'échec | `PENDING` → `FAILED` |

### Tables principales

```sql
-- Table wallets (1 par utilisateur)
wallets
├── id          UUID PRIMARY KEY
├── user_id     UUID (FK → auth.users)
├── balance     NUMERIC (crédits disponibles)
└── created_at  TIMESTAMPTZ

-- Table transactions (historique de toutes les opérations)
transactions
├── id            UUID PRIMARY KEY
├── wallet_id     UUID (FK → wallets)
├── amount        NUMERIC
├── type          ENUM: CREDIT | DEBIT
├── status        ENUM: PENDING | COMPLETED | FAILED
├── reference_id  TEXT (ID unique par opération)
├── metadata      JSONB
├── expires_at    TIMESTAMPTZ (pour les holds)
└── created_at    TIMESTAMPTZ

-- Table credit_packages (packs achetables)
credit_packages
├── id           TEXT PRIMARY KEY  (ex: "pack_100")
├── label        TEXT
├── credits      INTEGER
├── price        NUMERIC(10,2) (USD)
├── variant_id   TEXT (Lemon Squeezy)
├── checkout_url TEXT
├── is_active    BOOLEAN
└── features     JSONB
```

---

## 2. Schéma de base de données

### 2.1 Création des tables (migrations)

**Fichier : `migrations/create_credit_packages.sql`**

```sql
-- ═══════════════════════════════════════════════════════════════════
-- TABLE: credit_packages
-- Gère les packs de crédits disponibles à l'achat via Lemon Squeezy
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS credit_packages (
    id            TEXT PRIMARY KEY,          -- ex: "pack_100"
    label         TEXT NOT NULL,             -- ex: "Starter Pack"
    credits       INTEGER NOT NULL,          -- nombre de crédits ajoutés
    price         NUMERIC(10, 2) NOT NULL,   -- prix en USD
    currency      TEXT NOT NULL DEFAULT 'USD',
    yearly_price  NUMERIC(10, 2),            -- optional yearly billing amount
    variant_id    TEXT,                      -- Lemon Squeezy Variant ID
    checkout_url  TEXT,                      -- URL de checkout Lemon Squeezy
    popular       BOOLEAN DEFAULT FALSE,     -- badge "Popular" sur l'UI
    is_trial      BOOLEAN DEFAULT FALSE,     -- special pricing block
    is_active     BOOLEAN DEFAULT TRUE,      -- FALSE = caché sans supprimer
    sort_order    INTEGER DEFAULT 0,         -- ordre d'affichage
    description   TEXT,                     -- description optionnelle
    features      JSONB NOT NULL DEFAULT '[]'::jsonb, -- array of UI feature strings
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_credit_packages_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER credit_packages_updated_at
    BEFORE UPDATE ON credit_packages
    FOR EACH ROW EXECUTE FUNCTION update_credit_packages_updated_at();

-- ═══════════════════════════════════════════════════════════════════
-- SEED DATA
-- ═══════════════════════════════════════════════════════════════════

INSERT INTO credit_packages (id, label, credits, price, yearly_price, variant_id, checkout_url, popular, is_trial, sort_order, description, features) VALUES
(
    'pack_100',
    'Starter Pack',
    100,
    4.99,
    NULL,
    'REPLACE_WITH_LS_VARIANT_ID_100',
    'https://your-store.lemonsqueezy.com/checkout/buy/REPLACE_WITH_VARIANT_ID_100',
    FALSE,
    FALSE,
    1,
    'Perfect to get started',
    '["100 AI generations", "Access to all models", "Credits never expire"]'::jsonb
),
(
    'pack_500',
    'Creator Pack',
    500,
    19.99,
    NULL,
    'REPLACE_WITH_LS_VARIANT_ID_500',
    'https://your-store.lemonsqueezy.com/checkout/buy/REPLACE_WITH_VARIANT_ID_500',
    TRUE,   -- badge "Popular"
    FALSE,
    2,
    'Most popular — best value for creators',
    '["500 AI generations", "Access to all models", "Priority queue", "Credits never expire"]'::jsonb
),
(
    'pack_1000',
    'Studio Pack',
    1000,
    34.99,
    NULL,
    'REPLACE_WITH_LS_VARIANT_ID_1000',
    'https://your-store.lemonsqueezy.com/checkout/buy/REPLACE_WITH_VARIANT_ID_1000',
    FALSE,
    FALSE,
    3,
    'For power users and studios',
    '["1000 AI generations", "Access to all models", "Priority queue", "Batch generation", "Credits never expire"]'::jsonb
)
ON CONFLICT (id) DO UPDATE SET
    label        = EXCLUDED.label,
    credits      = EXCLUDED.credits,
    price        = EXCLUDED.price,
    yearly_price = EXCLUDED.yearly_price,
    variant_id   = EXCLUDED.variant_id,
    checkout_url = EXCLUDED.checkout_url,
    popular      = EXCLUDED.popular,
    is_trial     = EXCLUDED.is_trial,
    sort_order   = EXCLUDED.sort_order,
    description  = EXCLUDED.description,
    features     = EXCLUDED.features;

-- ═══════════════════════════════════════════════════════════════════
-- RLS (Row Level Security)
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE credit_packages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read active packages"
    ON credit_packages FOR SELECT
    USING (is_active = TRUE);
```

### 2.2 Fonctions PostgreSQL (RPC) pour atomicité

**Fichier : `src/services/WalletService.js` (lignes 555–675)**

```sql
-- 1. HOLD CREDITS (CREATE PENDING TRANSACTION)
CREATE OR REPLACE FUNCTION hold_credits(
  p_wallet_id UUID,
  p_amount NUMERIC,
  p_reference_id TEXT,
  p_metadata JSONB,
  p_expires_at TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_balance NUMERIC;
  v_transaction RECORD;
BEGIN
  IF EXISTS (SELECT 1 FROM transactions WHERE reference_id = p_reference_id) THEN
    RAISE EXCEPTION 'Transaction % already exists', p_reference_id USING ERRCODE = '23505';
  END IF;

  SELECT balance INTO v_balance FROM wallets WHERE id = p_wallet_id FOR UPDATE;
  
  IF v_balance IS NULL THEN RAISE EXCEPTION 'Wallet % not found', p_wallet_id; END IF;
  IF v_balance < p_amount THEN RAISE EXCEPTION 'Insufficient funds: need %, have %', p_amount, v_balance; END IF;

  UPDATE wallets SET balance = balance - p_amount WHERE id = p_wallet_id;

  INSERT INTO transactions (wallet_id, amount, type, status, reference_id, metadata, expires_at)
  VALUES (p_wallet_id, p_amount, 'DEBIT', 'PENDING', p_reference_id, p_metadata, p_expires_at)
  RETURNING * INTO v_transaction;

  RETURN row_to_json(v_transaction)::jsonb;
END;
$$;

-- 2. COMMIT TRANSACTION (MARK COMPLETED)
CREATE OR REPLACE FUNCTION commit_transaction(p_reference_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_transaction RECORD;
BEGIN
  SELECT * INTO v_transaction FROM transactions WHERE reference_id = p_reference_id FOR UPDATE;
  
  IF v_transaction IS NULL THEN RAISE EXCEPTION 'Transaction % not found', p_reference_id; END IF;
  IF v_transaction.status != 'PENDING' THEN RAISE EXCEPTION 'Transaction is not PENDING (current status: %)', v_transaction.status; END IF;

  UPDATE transactions SET status = 'COMPLETED' WHERE id = v_transaction.id RETURNING * INTO v_transaction;
  RETURN row_to_json(v_transaction)::jsonb;
END;
$$;

-- 3. ROLLBACK TRANSACTION (MARK FAILED & REFUND)
CREATE OR REPLACE FUNCTION rollback_transaction(p_reference_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_transaction RECORD;
BEGIN
  SELECT * INTO v_transaction FROM transactions WHERE reference_id = p_reference_id FOR UPDATE;
  
  IF v_transaction IS NULL THEN RAISE EXCEPTION 'Transaction % not found', p_reference_id; END IF;
  IF v_transaction.status != 'PENDING' THEN RAISE EXCEPTION 'Transaction is not PENDING (current status: %)', v_transaction.status; END IF;

  UPDATE wallets SET balance = balance + v_transaction.amount WHERE id = v_transaction.wallet_id;
  UPDATE transactions SET status = 'FAILED' WHERE id = v_transaction.id RETURNING * INTO v_transaction;

  RETURN row_to_json(v_transaction)::jsonb;
END;
$$;

-- 4. CREDIT WALLET (ADD FUNDS DIRECTLY)
CREATE OR REPLACE FUNCTION credit_wallet(
  p_wallet_id UUID,
  p_amount NUMERIC,
  p_reference_id TEXT,
  p_metadata JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_transaction RECORD;
BEGIN
  IF EXISTS (SELECT 1 FROM transactions WHERE reference_id = p_reference_id) THEN
    RAISE EXCEPTION 'Transaction % already exists', p_reference_id USING ERRCODE = '23505';
  END IF;

  UPDATE wallets SET balance = balance + p_amount WHERE id = p_wallet_id;

  INSERT INTO transactions (wallet_id, amount, type, status, reference_id, metadata)
  VALUES (p_wallet_id, p_amount, 'CREDIT', 'COMPLETED', p_reference_id, p_metadata)
  RETURNING * INTO v_transaction;

  RETURN row_to_json(v_transaction)::jsonb;
END;
$$;

-- 5. EXPIRE STALE HOLDS
CREATE OR REPLACE FUNCTION expire_stale_holds()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_tx RECORD;
  v_count INTEGER := 0;
BEGIN
  FOR v_tx IN
    SELECT * FROM transactions
    WHERE status = 'PENDING' AND expires_at < NOW()
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE wallets SET balance = balance + v_tx.amount WHERE id = v_tx.wallet_id;
    UPDATE transactions SET status = 'FAILED' WHERE id = v_tx.id;
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;
```

---

## 3. WalletService — Moteur central

**Fichier : `src/services/WalletService.js`** (676 lignes)

### 3.1 Classe et constructeur

```javascript
import { createClient } from "@supabase/supabase-js";

export class WalletError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "WalletError";
    this.code = code;  // INSUFFICIENT_FUNDS, DUPLICATE_TRANSACTION, DB_ERROR, etc.
  }
}

export class WalletService {
  HOLD_TTL_SECONDS = 60 * 60;  // 1 heure d'expiration pour les holds

  constructor(supabaseUrl, supabaseServiceKey) {
    this.supabase = createClient(supabaseUrl, supabaseServiceKey);
    this.defaultInitialBalance = Number(
      process.env.INITIAL_WALLET_BALANCE ||
      process.env.DEFAULT_WALLET_BALANCE ||
      0
    );
  }
```

### 3.2 Création / récupération du wallet

```javascript
  /**
   * FIX: استعمل upsert بدل check+insert لتفادي race condition
   */
  async createWallet(userId, initialBalance = this.defaultInitialBalance) {
    const { data, error } = await this.supabase
      .from("wallets")
      .insert({ user_id: userId, balance: initialBalance })
      .select("*")
      .maybeSingle();

    if (error) {
      if (error.code === "23505" || error.code === "23503") {
        // Race condition: wallet was created between check and insert
        const { data: existing, error: selectErr } = await this.supabase
          .from("wallets")
          .select("*")
          .eq("user_id", userId)
          .single();
        if (selectErr) throw new WalletError(selectErr.message, "DB_ERROR");
        return existing;
      }
      throw new WalletError(error.message, "DB_ERROR");
    }

    console.log(`[WalletService] Wallet ensured for user ${userId}.`);
    return data;
  }

  async ensureWallet(userId, initialBalance = this.defaultInitialBalance) {
    return this.createWallet(userId, initialBalance);
  }
```

### 3.3 Hold — Bloquer les crédits

```javascript
  async hold({ userId, amount, referenceId, metadata = {} }) {
    this.validateMetadata(metadata); // FIX: validate avant toute opération

    const wallet = await this.getWalletOrThrow(userId);

    if (wallet.balance < amount) {
      throw new WalletError(
        `Insufficient funds: need ${amount}, have ${wallet.balance}`,
        "INSUFFICIENT_FUNDS"
      );
    }

    const expiresAt = new Date(
      Date.now() + this.HOLD_TTL_SECONDS * 1000
    ).toISOString();

    // Appel RPC atomique hold_credits
    const { data: tx, error } = await this.supabase.rpc("hold_credits", {
      p_wallet_id: wallet.id,
      p_amount: amount,
      p_reference_id: referenceId,
      p_metadata: metadata,
      p_expires_at: expiresAt,
    });

    if (error) {
      if (this.isMissingRpcError(error)) {
        console.warn("[WalletService] RPC hold_credits not found, using table fallback.");
        return this.holdFallback({ wallet, amount, referenceId, metadata, expiresAt });
      }

      if (error.code === "23505") {
        throw new WalletError(
          `Transaction ${referenceId} already exists (duplicate)`,
          "DUPLICATE_TRANSACTION"
        );
      }

      throw new WalletError(error.message, "DB_ERROR");
    }

    return tx;
  }
```

### 3.4 Commit — Confirmer la consommation

```javascript
  async commit(referenceId) {
    return this.resolveTransaction(referenceId, "COMPLETED");
  }

  /**
   * Safe when BullMQ replays the job: if the hold was already committed, this is a no-op.
   */
  async commitHoldIdempotent(referenceId) {
    if (!referenceId) return;
    try {
      await this.commit(referenceId);
    } catch (err) {
      if (!(err instanceof WalletError)) throw err;
      const { data: tx } = await this.supabase
        .from("transactions")
        .select("status")
        .eq("reference_id", referenceId)
        .maybeSingle();
      if (tx?.status === "COMPLETED") return;  // Déjà complété, ignorer
      throw err;
    }
  }
```

### 3.5 Rollback — Rembourser les crédits

```javascript
  async rollback(referenceId) {
    return this.resolveTransaction(referenceId, "FAILED");
  }

  async resolveTransaction(referenceId, newStatus) {
    const fnName =
      newStatus === "COMPLETED" ? "commit_transaction" : "rollback_transaction";

    const { data: tx, error } = await this.supabase.rpc(fnName, {
      p_reference_id: referenceId,
    });

    if (error) {
      if (this.isMissingRpcError(error)) {
        console.warn(`[WalletService] RPC ${fnName} not found, using table fallback.`);
        return newStatus === "COMPLETED"
          ? this.commitFallback(referenceId)
          : this.rollbackFallback(referenceId);
      }

      throw new WalletError(error.message, "TRANSACTION_NOT_FOUND");
    }

    return tx;
  }
```

### 3.6 Credit — Ajouter des crédits (recharge)

```javascript
  async credit({ userId, amount, referenceId, metadata = {} }) {
    this.validateMetadata(metadata);

    const wallet = await this.getWalletOrThrow(userId);

    const { data: tx, error } = await this.supabase.rpc("credit_wallet", {
      p_wallet_id: wallet.id,
      p_amount: amount,
      p_reference_id: referenceId,
      p_metadata: metadata,
    });

    if (error) {
      if (this.isMissingRpcError(error)) {
        console.warn("[WalletService] RPC credit_wallet not found, using table fallback.");
        return this.creditFallback({ wallet, amount, referenceId, metadata });
      }

      if (error.code === "23505") {
        throw new WalletError(
          `Transaction ${referenceId} already exists (duplicate)`,
          "DUPLICATE_TRANSACTION"
        );
      }

      throw new WalletError(error.message, "DB_ERROR");
    }

    return tx;
  }
```

### 3.7 Queries — Balance et transactions

```javascript
  async getBalance(userId) {
    const wallet = await this.getWalletOrThrow(userId);
    return wallet.balance;
  }

  async checkSufficientFunds(userId, amount) {
    const wallet = await this.getWalletOrThrow(userId);

    if (wallet.balance < amount) {
      throw new WalletError(
        `Insufficient funds: need ${amount}, have ${wallet.balance}`,
        "INSUFFICIENT_FUNDS"
      );
    }

    return true;
  }

  async getTransactions(userId, limit = 20, offset = 0) {
    const wallet = await this.getWalletOrThrow(userId);

    const { data, error } = await this.supabase
      .from("transactions")
      .select("*")
      .eq("wallet_id", wallet.id)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw new WalletError(error.message, "DB_ERROR");

    return data ?? [];
  }
```

### 3.8 Expiration des holds périmés

```javascript
  async expireStaleHolds() {
    const { data, error } = await this.supabase.rpc("expire_stale_holds");

    if (error) {
      if (this.isMissingRpcError(error)) {
        console.warn("[WalletService] RPC expire_stale_holds not found, using table fallback.");
        return this.expireStaleHoldsFallback();
      }
      throw new WalletError(error.message, "DB_ERROR");
    }

    return data ?? 0;
  }
```

### 3.9 Helpers internes

```javascript
  async getWalletOrThrow(userId) {
    const { data, error } = await this.supabase
      .from("wallets")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();  // FIX: maybeSingle() au lieu de single()

    if (error) throw new WalletError(error.message, "DB_ERROR");
    if (!data) throw new WalletError(`Wallet not found for user ${userId}`, "WALLET_NOT_FOUND");

    return data;
  }

  isMissingRpcError(error) {
    const message = String(error?.message || "").toLowerCase();
    return error?.code === "PGRST202" || message.includes("schema cache");
  }

  validateMetadata(metadata) {
    if (typeof metadata !== "object" || Array.isArray(metadata) || metadata === null) {
      throw new WalletError("Metadata must be a plain object", "INVALID_METADATA");
    }
    const json = JSON.stringify(metadata);
    if (json.length > this.METADATA_MAX_BYTES) {  // ⚠️ METADATA_MAX_BYTES non défini !
      throw new WalletError(
        `Metadata too large (max ${this.METADATA_MAX_BYTES} bytes)`,
        "INVALID_METADATA"
      );
    }
  }
```

### 3.10 Fallbacks JS (quand les RPC ne sont pas disponibles)

```javascript
  // holdFallback avec optimistic locking
  async holdFallback({ wallet, amount, referenceId, metadata, expiresAt }) {
    // ① re-read le wallet avec la dernière valeur (optimistic lock snapshot)
    const fresh = await this.getWalletByIdOrThrow(wallet.id);

    const newBalance = Number(fresh.balance) - Number(amount);
    if (newBalance < 0) {
      throw new WalletError(
        `Insufficient funds: need ${amount}, have ${fresh.balance}`,
        "INSUFFICIENT_FUNDS"
      );
    }

    // ② insert transaction d'abord — si duplicate, on ne touche pas le balance
    const { data: tx, error: txError } = await this.supabase
      .from("transactions")
      .insert({
        wallet_id: fresh.id,
        amount,
        type: "DEBIT",
        status: "PENDING",
        reference_id: referenceId,
        metadata,
        expires_at: expiresAt,
      })
      .select("*")
      .single();

    if (txError) {
      if (txError.code === "23505") {
        throw new WalletError(
          `Transaction ${referenceId} already exists (duplicate)`,
          "DUPLICATE_TRANSACTION"
        );
      }
      throw new WalletError(txError.message, "DB_ERROR");
    }

    // ③ update balance avec optimistic lock: .eq("balance", fresh.balance)
    const { error: walletError, count } = await this.supabase
      .from("wallets")
      .update({ balance: newBalance })
      .eq("id", fresh.id)
      .eq("balance", fresh.balance);  // FIX: optimistic lock

    if (walletError || count === 0) {
      // rollback: supprimer la transaction qu'on a ajoutée
      await this.supabase
        .from("transactions")
        .delete()
        .eq("reference_id", referenceId);

      throw new WalletError(
        "Balance changed concurrently, please retry",
        "CONFLICT"
      );
    }

    return tx;
  }

  // rollbackFallback avec refund
  async rollbackFallback(referenceId) {
    const tx = await this.getTransactionByReferenceOrThrow(referenceId);

    if (tx.status === "FAILED") return tx;  // Idempotent
    if (tx.status !== "PENDING") {
      throw new WalletError(
        `Cannot rollback: status is ${tx.status}`,
        "INVALID_TRANSITION"
      );
    }

    // ① lock le status avec optimistic lock
    const { data: updated, error: txError } = await this.supabase
      .from("transactions")
      .update({ status: "FAILED" })
      .eq("id", tx.id)
      .eq("status", "PENDING")  // FIX: si quelqu'un l'a changé avant → échec
      .select("*")
      .single();

    if (txError || !updated) {
      throw new WalletError(
        "Transaction was modified concurrently",
        "CONFLICT"
      );
    }

    // ② après avoir sécurisé le status, on rembourse le balance
    const wallet = await this.getWalletByIdOrThrow(tx.wallet_id);
    const { error: walletError } = await this.supabase
      .from("wallets")
      .update({ balance: Number(wallet.balance) + Number(tx.amount) })
      .eq("id", wallet.id);

    if (walletError) {
      throw new WalletError(walletError.message, "DB_ERROR");
    }

    return updated;
  }
```

---

## 4. Mécanisme Hold / Commit / Rollback

### Diagramme du cycle de vie d'une transaction

```
┌─────────────────────────────────────────────────────────────┐
│                    HOLD (début génération)                  │
│  user clicks "Generate"                                      │
│       ↓                                                      │
│  checkSufficientFunds(userId, amount)                       │
│       ↓                                                      │
│  balance -= amount (déduit immédiatement)                  │
│       ↓                                                      │
│  INSERT transaction (type=DEBIT, status=PENDING)           │
│       ↓                                                      │
│  BullMQ enqueue(job)                                        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
        ┌─────────────────────────────┐
        │      Worker exécute job      │
        │         (génération IA)      │
        └─────────────────────────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
    ┌──────────────┐              ┌──────────────┐
    │   SUCCESS    │              │    FAILED    │
    │              │              │              │
    │  commit()    │              │  rollback()  │
    │  status →    │              │  status →    │
    │  COMPLETED   │              │  FAILED      │
    │              │              │  balance +=  │
    │  (crédits    │              │  amount      │
    │  déjà pris)  │              │  (refund)    │
    └──────────────┘              └──────────────┘
```

### TTL (Time To Live) des holds

```javascript
HOLD_TTL_SECONDS = 60 * 60  // 1 heure
```

Si un job échoue silencieusement (worker crash, provider timeout), le hold reste `PENDING`. La fonction `expire_stale_holds()` s'assure de les rembourser automatiquement après 1 heure.

---

## 5. Intégration avec les générations (Treatments)

### 5.1 Pricing — Calcul des crédits

**Fichier : `lib/pricingUtils.js`**

```javascript
/**
 * Unified Pricing Calculator
 * Automatically detects whether the model is image or video
 */
export function calculateCredits({
    modelKey,
    durationSeconds,
    resolution = "720p",
    quality = "standard",
    operation = "generated",
    count = 1,
} = {}) {
  if (!modelKey) throw new Error("[pricingUtils] modelKey is required");

  const domain = detectModelDomain(modelKey);  // "video" | "image"
  if (!domain) throw new Error(`[pricingUtils] Model "${modelKey}" not found`);

  // Video pricing
  if (domain === "video") {
    const result = calculateVideoCredits({
      modelKey,
      durationSeconds: durationSeconds ?? 5,
      resolution,
      count,
    });
    return { domain, ...result };
  }

  // Image pricing
  if (domain === "image") {
    const result = calculateImageCredits({
      modelKey,
      quality,
      count,
      operation,
    });
    return { domain, ...result };
  }
}
```

### 5.2 Base Treatment — Wallet check avant DB writes

**Fichier : `src/image/treatments/basetretment/BaseGenerateImageTreatment.js`**

```javascript
export class BaseGenerateImageTreatment {
  constructor({ promptService, models, storageService, db, walletService = null }) {
    this.promptService  = promptService;
    this.models         = models;
    this.storageService = storageService;
    this.db             = db;
    this.walletService  = walletService;  // Injected via container
    this.imageHoldAmountPerAsset = Number(process.env.IMAGE_GENERATION_HOLD_AMOUNT || 10);
  }

  async _runPrepare({
    prompt, model_name, userId, project_id,
    ratio, quality, steps, guidance_scale, count = 1,
    // ... autres params
  }) {

    // 1. Provider check (fast fail)
    this._resolveProvider(model_name, input_assets);

    // 2. Validate & clamp generation params
    const provider = this._resolveProvider(model_name, input_assets);
    const verified = verifyAndClampParams(provider, { steps, guidance_scale, ratio, quality, count });

    // 3. NEW: Check Wallet Balance before DB writes
    let holdAmount = 0;
    let pricingDetails = null;
    if (this.walletService && userId) {
      pricingDetails = calculateImageCredits({
        modelKey: model_name || "z_image",
        quality: verified.quality || "standard",
        count: verified.count,
        operation: "generated",
      });
      holdAmount = pricingDetails.credits;

      if (holdAmount > 0) {
        await this.walletService.checkSufficientFunds(userId, holdAmount);
      }
    }

    // 4. Compute pixel dimensions
    // 5. Create generation_config
    // 6. Create batch (if count > 1)
    // 7. Create workflows
    // 8. Create media placeholders
    // 9. Return task descriptor
    return {
      userId, project_id, model_name, prompt,
      walletHoldAmount: holdAmount,
      pricingDetails,
      // ... DB IDs
    };
  }
```

### 5.3 Execute — Enchaînement complet

```javascript
  async execute(input) {
    let task;
    try {
      task = await this.prepare(input);  // Calls _runPrepare()
    } catch (error) {
      throw error;
    }

    const userId = input?.userId || input?.user_id;
    const shouldHoldCredits =
      !!this.walletService &&
      !!userId &&
      !!task?.configId &&
      (task.walletHoldAmount > 0);

    let walletReferenceId = null;

    // ── HOLD PHASE ──
    if (shouldHoldCredits) {
      this._log("info", `holding credits for user:${userId} | configId:${task.configId}`);
      walletReferenceId = task.configId;  // referenceId = configId

      await this.walletService.hold({
        userId: userId,
        amount: task.walletHoldAmount,
        referenceId: walletReferenceId,
        metadata: {
          treatment: this.getQueueType(),
          model_name: task.model_name || input?.model_name || null,
          prompt: task.prompt || input?.prompt || null,
          count: task.count,
          project_id: task.project_id || input?.project_id || null,
          session_id: task.session_id || input?.session_id || null,
          pricingVersion: task.pricingDetails?.pricingVersion,
          pricingBreakdown: task.pricingDetails?.breakdown,
        },
      });

      const wallet = await this.walletService.getWalletOrThrow(userId);
      task.remainingBalance = wallet.balance;  // Pour réponse au frontend
    }

    if (walletReferenceId) {
      task.walletReferenceId = walletReferenceId;
    }

    // ── ENQUEUE TO BULLMQ ──
    let job;
    try {
      job = await enqueueTreatmentJob(
        this.getQueueType(),
        task,
        walletReferenceId ? { jobId: walletReferenceId } : {}
      );
    } catch (error) {
      // Si enqueue échoue → rollback immédiat
      if (this.walletService && walletReferenceId) {
        try {
          await this.walletService.rollback(walletReferenceId);
        } catch (walletError) {
          this._log("error", `wallet rollback after enqueue failure: ${walletError.message}`);
        }
      }
      throw error;
    }

    return {
      jobId: job.id,
      status: "queued",
      batchId: task.batchId ?? null,
      configId: task.configId ?? null,
      workflows: task.workflows ?? [],
      provider: task.model_name ?? null,
      balance: task.remainingBalance ?? null,  // Frontend affiche le solde restant
    };
  }
```

### 5.4 Worker — Commit ou Rollback après génération

```javascript
  async runJob(task) {
    try {
      // Si toutes les médias sont déjà done (replay/dup), commit direct
      const duplicateSkip = await skipIfAllMediaAlreadyDone(this.db, task.mediaIds);
      if (duplicateSkip) {
        if (this.walletService && task.walletReferenceId) {
          await this.walletService.commitHoldIdempotent(task.walletReferenceId);
        }
        return {
          batchId: task.batchId ?? null,
          configId: task.configId,
          ...duplicateSkip,
        };
      }

      // Exécution normale: optimize → generate → upload → DB update
      const optimized = await this.optimizePrompt(task);
      const result = await this.run(task, optimized);

      // SUCCESS → Commit
      if (this.walletService && task.walletReferenceId) {
        await this.walletService.commitHoldIdempotent(task.walletReferenceId);
      }

      return result;

    } catch (error) {
      // FAILED → Rollback (refund)
      if (this.walletService && task.walletReferenceId) {
        try {
          await this.walletService.rollback(task.walletReferenceId);
        } catch (walletError) {
          this._log("error", `wallet rollback failed for ${task.walletReferenceId}: ${walletError.message}`);
        }
      }

      throw error;
    }
  }
```

---

## 6. Système de paiement (Lemon Squeezy)

### 6.1 Routes

**Fichier : `routes/payments.js`**

```javascript
import express from "express";
import {
    getCheckoutUrl,
    handleWebhook,
    getPurchaseHistory,
    getCreditPackages,
} from "../controllers/paymentsController.js";
import { requireAuth } from "../src/middleware/auth.js";

const router = express.Router();

// Public: liste des packs
router.get("/packages", getCreditPackages);

// Protected: checkout URL (Lemon Squeezy)
router.post("/checkout", requireAuth, getCheckoutUrl);

// Webhook: public, sécurisé par HMAC-SHA256
router.post("/webhook", express.raw({ type: "application/json" }), handleWebhook);

// Protected: historique d'achats
router.get("/history", requireAuth, getPurchaseHistory);

export default router;
```

### 6.2 Controller — Checkout

**Fichier : `controllers/paymentsController.js`** (extrait)

```javascript
export async function getCheckoutUrl(req, res) {
    try {
        const { packageId } = req.body;
        const userId = req.user?.id;

        if (!packageId) {
            return res.status(400).json({ ok: false, message: "packageId is required" });
        }

        // Fetch package depuis Supabase
        const { data: pkg, error } = await supabase
            .from("credit_packages")
            .select("*")
            .eq("id", packageId)
            .eq("is_active", true)
            .maybeSingle();

        if (error || !pkg) {
            return res.status(404).json({ ok: false, message: "Package not found" });
        }

        // Récupérer email user
        const { data: { user }, error: userError } = await supabase.auth.admin.getUserById(userId);

        // Build checkout URL avec custom data
        const url = new URL(pkg.checkout_url);
        if (user.email) url.searchParams.set("checkout[email]", user.email);
        url.searchParams.set("checkout[custom][user_id]", userId);
        url.searchParams.set("checkout[custom][package_id]", pkg.id);

        return res.status(200).json({
            ok: true,
            checkoutUrl: url.toString(),
            package: { id: pkg.id, credits: pkg.credits, price: pkg.price, label: pkg.label },
        });
    } catch (err) {
        console.error("[Payments] getCheckoutUrl error:", err);
        return res.status(500).json({ ok: false, message: "Internal server error" });
    }
}
```

### 6.3 Controller — Webhook (recharge automatique)

```javascript
export async function handleWebhook(req, res) {
    const rawBody = req.body instanceof Buffer ? req.body.toString("utf8") : JSON.stringify(req.body);
    const signature = req.headers["x-signature"];

    // ① Vérification HMAC-SHA256
    const isValid = verifyWebhookSignature(rawBody, signature);
    if (!isValid) {
        return res.status(401).json({ ok: false, message: "Invalid signature" });
    }

    const event = JSON.parse(rawBody);
    const eventName = event?.meta?.event_name;

    // ② On ne traite que order_created payé
    if (eventName !== "order_created") {
        return res.status(200).json({ ok: true, message: `Event ${eventName} ignored` });
    }

    const customData = event?.meta?.custom_data || {};
    const userId = customData.user_id;
    const packageId = customData.package_id;
    const orderId = String(event?.data?.id);
    const orderStatus = event?.data?.attributes?.status;

    if (orderStatus !== "paid") {
        return res.status(200).json({ ok: true, message: "Order not paid, skipped" });
    }

    // ③ Lookup crédits par variant_id (fiable) ou package_id (fallback)
    let creditsToAdd = null;
    const variantId = String(event?.data?.attributes?.first_order_item?.variant_id);

    if (variantId) {
        const { data: pkgByVariant } = await supabase
            .from("credit_packages")
            .select("credits")
            .eq("variant_id", variantId)
            .maybeSingle();
        creditsToAdd = pkgByVariant?.credits ?? null;
    }

    if (!creditsToAdd && packageId) {
        const { data: pkgById } = await supabase
            .from("credit_packages")
            .select("credits")
            .eq("id", packageId)
            .maybeSingle();
        creditsToAdd = pkgById?.credits ?? null;
    }

    // ④ Créditer le wallet (idempotent via referenceId = orderId)
    const referenceId = `ls_order_${orderId}`;

    await walletService.credit({
        userId,
        amount: creditsToAdd,
        referenceId,
        metadata: {
            source: "lemon_squeezy",
            orderId,
            variantId,
            packageId: packageId || null,
        },
    });

    return res.status(200).json({ ok: true, message: "Credits added successfully" });
}
```

### 6.4 Vérification de signature HMAC

**Fichier : `controllers/payments/paymentsUtils.js`**

```javascript
import crypto from "crypto";

export function verifyWebhookSignature(rawBody, signature) {
    const secret = process.env.LEMON_WEBHOOK_SECRET;

    if (!secret) {
        console.error("[Payments] LEMON_WEBHOOK_SECRET is not set!");
        return false;
    }

    if (!signature) return false;

    const hmac = crypto
        .createHmac("sha256", secret)
        .update(rawBody)
        .digest("hex");

    const hmacBuffer = Buffer.from(hmac, "hex");
    const sigBuffer = Buffer.from(signature, "hex");

    if (hmacBuffer.length !== sigBuffer.length) return false;

    return crypto.timingSafeEqual(hmacBuffer, sigBuffer);  // Timing-safe comparison
}
```

### 6.5 Historique d'achats

```javascript
export async function getPurchaseHistory(req, res) {
    const userId = req.user?.id;

    const transactions = await walletService.getTransactions(userId, 20, 0);

    const purchases = transactions
        .filter((tx) => tx.type === "CREDIT" && tx.metadata?.source === "lemon_squeezy")
        .map((tx) => ({
            id: tx.id,
            credits: tx.amount,
            orderId: tx.metadata?.orderId,
            packageId: tx.metadata?.packageId,
            date: tx.created_at,
            status: tx.status,
        }));

    return res.status(200).json({ ok: true, purchases });
}
```

---

## 7. Gestion des race conditions et sécurité

### 7.1 Double-spend protection

| Technique | Implémentation | Objectif |
|-----------|---------------|----------|
| **reference_id unique** | `UNIQUE` constraint sur `transactions.reference_id` | Empêche d'avoir 2 transactions avec le même ID |
| **RPC atomique** | PostgreSQL `FOR UPDATE` + transaction | Lock la ligne wallet pendant l'opération |
| **Optimistic lock** | `UPDATE ... WHERE balance = old_balance` | Fallback JS quand RPC indisponible |
| **Insert-first** | Transaction insérée avant balance update | Si insert fail, balance non touché |

### 7.2 Idempotence

```javascript
// Commit idempotent
async commitHoldIdempotent(referenceId) {
    if (!referenceId) return;
    try {
        await this.commit(referenceId);
    } catch (err) {
        // Si déjà COMPLETED → ignorer silencieusement
        const { data: tx } = await this.supabase
            .from("transactions")
            .select("status")
            .eq("reference_id", referenceId)
            .maybeSingle();
        if (tx?.status === "COMPLETED") return;
        throw err;
    }
}

// Rollback idempotent
async rollbackFallback(referenceId) {
    const tx = await this.getTransactionByReferenceOrThrow(referenceId);
    if (tx.status === "FAILED") return tx;  // Déjà failed → no-op
    // ... reste du rollback
}
```

### 7.3 Webhook idempotent (Lemon Squeezy)

```javascript
// Dans le webhook controller
} catch (err) {
    if (err?.code === "DUPLICATE_TRANSACTION") {
        // Webhook re-joué → retourner 200 OK
        return res.status(200).json({ ok: true, message: "Already processed" });
    }
    throw err;
}
```

### 7.4 Stale holds cleanup

```javascript
// expire_stale_holds() — à appeler via cron ou périodiquement
async expireStaleHoldsFallback() {
    const now = new Date().toISOString();

    // Atomic claim: change le status en FAILED
    const { data: expired, error } = await this.supabase
        .from("transactions")
        .update({ status: "FAILED" })
        .eq("status", "PENDING")
        .lt("expires_at", now)
        .select("*");

    // Rembourser chaque transaction
    for (const tx of expired || []) {
        const wallet = await this.getWalletByIdOrThrow(tx.wallet_id);
        await this.supabase
            .from("wallets")
            .update({ balance: Number(wallet.balance) + Number(tx.amount) })
            .eq("id", wallet.id);
    }

    return expired?.length ?? 0;
}
```

---

## 8. Architecture de dépendances (Container)

**Fichier : `src/container.js`**

```javascript
import { WalletService } from "#services/WalletService.js";

// ─── Services ────────────────────────────────────────────────────────────
const walletServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || 
                         process.env.SUPABASE_KEY || null;

export const walletService = process.env.SUPABASE_URL && walletServiceKey
    ? new WalletService(process.env.SUPABASE_URL, walletServiceKey)
    : null;

if (walletService) {
    console.log("[Container] WalletService initialized.");
} else {
    console.warn("[Container] WalletService disabled: missing SUPABASE_URL or service key.");
}

// ─── Treatments (chaque treatment reçoit walletService) ───────────────────
export const videoTreatment = new VideoTreatment({
    promptService, storageService, db, walletService
});

export const imageTreatmentV2 = new ImageTreatmentV2({
    promptService, models: IMAGE_MODELS, storageService, db, walletService
});

export const editImageTreatment = new EditImageTreatment({
    promptService, models: IMAGE_MODELS, storageService, db, walletService
});

// ... etc pour tous les treatments

// ─── Workflow Architecture (Feature 008) ─────────────────────────────────
export const workflowBillingGateway = new WorkflowBillingGateway({ walletService });
// BillingGateway: abstraction pour séparer le billing de la logique métier
```

### WorkflowBillingGateway (abstraction)

**Fichier : `src/infrastructure/billing/workflowBillingGateway.js`**

```javascript
export class WorkflowBillingGateway {
  constructor({ walletService = null } = {}) {
    this.walletService = walletService;
  }

  async reserve({ userId, amount = 0, referenceId, metadata = {} }) {
    if (!this.walletService || amount <= 0) {
      return { status: "skipped", referenceId, amount };
    }
    return this.walletService.hold({ userId, amount, referenceId, metadata });
  }

  async settle(referenceId) {
    if (!this.walletService || !referenceId) return { status: "skipped", referenceId };
    return this.walletService.commitHoldIdempotent
      ? this.walletService.commitHoldIdempotent(referenceId)
      : this.walletService.commit(referenceId);
  }

  async rollback(referenceId) {
    if (!this.walletService || !referenceId) return { status: "skipped", referenceId };
    return this.walletService.rollback(referenceId);
  }
}
```

---

## 9. Points forts et axes d'amélioration

### ✅ Points forts

| Aspect | Description |
|--------|-------------|
| **Atomicité** | Hold déduit les crédits immédiatement avant la génération |
| **Idempotence** | Commit/rollback peuvent être rejoués sans double consommation |
| **Fallbacks** | 5 fonctions RPC + fallback JS complet si RPC indisponible |
| **Optimistic locking** | `WHERE balance = old_balance` prévente les race conditions |
| **Webhook sécurisé** | HMAC-SHA256 avec timing-safe comparison |
| **Abstraction** | `WorkflowBillingGateway` sépare le billing du métier |
| **Metadata tracé** | Chaque transaction a un JSONB avec model, prompt, etc. |

### ⚠️ Axes d'amélioration

| Problème | Fichier | Impact | Solution suggérée |
|----------|---------|--------|-------------------|
| `METADATA_MAX_BYTES` non défini | `WalletService.js` | `undefined` → validation metadata fail silencieusement | Ajouter `METADATA_MAX_BYTES = 4096` |
| Pas de cron pour `expireStaleHolds` | `WalletService.js` | Holds PENDING peuvent rester bloqués | Ajouter job cron BullMQ ou cron externe |
| `wallet/balance` dans authRoutes | `routes/authRoutes.js` | Mixing concerns | Déplacer vers `routes/payments.js` ou `routes/wallet.js` |
| `initialBalance = 0` hardcodé | `authController.js` | Nouveaux users commencent à 0 | Rendre configurable via env var |
| Pas de route `POST /wallet/credit` admin | Absent | Pas de moyen de créditer manuellement | Ajouter route admin protégée |
| Pricing hardcodé dans modelRouter | `image/core/modelRouter.js` | Modification prix nécessite déploiement | Table `pricing_rules` dynamique |
| Pas de `wallet/balance` WebSocket | Absent | Frontend doit poller | Émettre event Socket.IO quand balance change |
| `creditPackages` manque `test` env | `create_credit_packages.sql` | Variant IDs sont des placeholders | Mettre à jour avec vrais IDs Lemon Squeezy |

---

## 10. Diagramme de flux complet

```
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                              OPENART WALLET SYSTEM FLOW                                  │
└─────────────────────────────────────────────────────────────────────────────────────────┘

                              ┌──────────────┐
                              │   FRONTEND   │
                              └──────┬───────┘
                                     │
                                     ▼
┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                                    API SERVER                                           │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │  authRoutes.js  │  │  payments.js    │  │  images.js      │  │  video.js       │  │
│  │                 │  │                 │  │                 │  │                 │  │
│  │ GET /wallet/    │  │ GET /packages   │  │ POST /generate  │  │ POST /generate  │  │
│  │    balance      │  │ POST /checkout  │  │                 │  │                 │  │
│  │ POST /signup    │  │ POST /webhook   │  │                 │  │                 │  │
│  │ POST /login     │  │ GET /history    │  │                 │  │                 │  │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘  │
│           │                    │                    │                    │           │
│           ▼                    ▼                    ▼                    ▼           │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│  │                        CONTROLLERS / TREATMENTS                               │  │
│  │                                                                               │  │
│  │  authController        paymentsController        BaseGenerateImageTreatment  │  │
│  │  ├── signup()          ├── getCreditPackages()   ├── prepare()               │  │
│  │  ├── login()           ├── getCheckoutUrl()      ├── execute()               │  │
│  │  ├── getMe()           ├── handleWebhook()      └── runJob()                │  │
│  │  └── getWalletBalance()├── getPurchaseHistory()        │                     │  │
│  │                        │                            │                      │  │
│  └────────────────────────┼────────────────────────────┼──────────────────────┘  │
│                             │                            │                          │
│                             ▼                            ▼                          │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│  │                        WalletService                                            │  │
│  │                                                                               │  │
│  │  hold(userId, amount, refId)     ──→  RPC hold_credits() ou holdFallback()  │  │
│  │  commit(refId)                   ──→  RPC commit_transaction()                │  │
│  │  rollback(refId)                 ──→  RPC rollback_transaction()              │  │
│  │  credit(userId, amount, refId)   ──→  RPC credit_wallet()                   │  │
│  │  getBalance(userId)              ──→  SELECT balance FROM wallets             │  │
│  │  getTransactions(userId)         ──→  SELECT * FROM transactions             │  │
│  │  expireStaleHolds()              ──→  RPC expire_stale_holds()                │  │
│  └──────────────────────────────────────────────────────────────────────────────┘  │
│                                      │                                               │
│                                      ▼                                               │
│  ┌──────────────────────────────────────────────────────────────────────────────┐  │
│  │                        SUPABASE POSTGRESQL                                    │  │
│  │                                                                               │  │
│  │  ┌──────────┐   ┌──────────────┐   ┌─────────────────┐   ┌──────────────┐     │  │
│  │  │ wallets  │   │ transactions │   │ credit_packages │   │   autres    │     │  │
│  │  │          │   │              │   │                 │   │   tables    │     │  │
│  │  │ user_id  │◄──│ wallet_id    │   │ id, label       │   │             │     │  │
│  │  │ balance  │   │ amount       │   │ credits         │   │             │     │  │
│  │  │          │   │ type         │   │ price           │   │             │     │  │
│  │  │          │   │ status       │   │ variant_id      │   │             │     │  │
│  │  │          │   │ reference_id │   │ checkout_url    │   │             │     │  │
│  │  │          │   │ expires_at   │   │                 │   │             │     │  │
│  │  └──────────┘   └──────────────┘   └─────────────────┘   └─────────────┘     │  │
│  └──────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                      │
└──────────────────────────────────────────────────────────────────────────────────────┘
                                     │
                                     │ Webhook
                                     ▼
                              ┌──────────────┐
                              │ LEMON SQUEEZY│
                              │  (payment)   │
                              └──────────────┘


┌─────────────────────────────────────────────────────────────────────────────────────────┐
│                            GÉNÉRATION FLOW (avec Wallet)                                │
└─────────────────────────────────────────────────────────────────────────────────────────┘

  User ──► POST /api/images/generate
              │
              ▼
  ┌──────────────────────┐
  │ 1. prepare(input)    │  ← Crée config + workflows + media placeholders
  │    check funds       │  ← checkSufficientFunds(userId, amount)
  │    calculateCredits  │  ← selon model, quality, count
  └──────────┬───────────┘
             │
             ▼
  ┌──────────────────────┐
  │ 2. hold()            │  ← Déduit crédits, crée transaction PENDING
  │    referenceId =     │  ← configId (unique par génération)
  │    metadata = {      │
  │      model, prompt,  │
  │      project_id      │
  │    }                 │
  └──────────┬───────────┘
             │
             ▼
  ┌──────────────────────┐
  │ 3. BullMQ enqueue    │  ← Job avec walletReferenceId dans payload
  │    Return to user:   │
  │    { jobId, status,  │
  │      balance }       │
  └──────────┬───────────┘
             │
             ▼
  ┌──────────────────────┐        ┌──────────────────────┐
  │ 4. Worker runJob()   │        │ Worker runJob()      │
  │    optimizePrompt()  │        │    optimizePrompt()   │
  │    run() → generate  │        │    run() → FAIL      │
  │    upload → success  │        │                      │
  │                      │        │                      │
  │    commit(refId)     │        │    rollback(refId)   │
  │    PENDING→COMPLETED │        │    PENDING→FAILED    │
  │                      │        │    refund balance    │
  │    ✓ Credits déjà    │        │    ✓ Crédits remb.   │
  │      pris, rien à    │        │                      │
  │      faire d'autre   │        │                      │
  └──────────┬───────────┘        └──────────┬───────────┘
             │                                │
             ▼                                ▼
  ┌──────────────────────┐        ┌──────────────────────┐
  │ 5. Socket.IO emit    │        │ 5. Socket.IO emit    │
  │    "generation:done" │        │    "generation:fail" │
  │    avec media URL    │        │    avec error        │
  └──────────────────────┘        └──────────────────────┘
```

---

## Conclusion

Le système de wallet d'OpenArt est une **implémentation robuste** d'un système de crédits prépayés avec mécanisme de hold/commit/rollback. L'architecture est bien découplée grâce au `WorkflowBillingGateway` et supporte les scénarios de production (race conditions, replay, failover RPC). Les principales forces résident dans l'atomicité des opérations PostgreSQL et l'idempotence du commit/rollback.

Les améliorations prioritaires sont :
1. **Corriger `METADATA_MAX_BYTES`** (bug actuel)
2. **Ajouter un cron** pour `expireStaleHolds`
3. **Mettre à jour les vrais variant IDs** Lemon Squeezy
4. **Considérer un endpoint admin** pour créditer manuellement

---

*Document généré pour l'analyse du projet OpenArt (PFE Licence Informatique)*
