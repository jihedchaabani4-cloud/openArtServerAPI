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
    is_trial      BOOLEAN DEFAULT FALSE,     -- special pricing block (education/trial/etc.)
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
-- SEED DATA — Remplace les variant_id et checkout_url par les vrais
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
-- credit_packages est PUBLIC en lecture (tout le monde peut voir les packs)
-- Seuls les admins peuvent modifier
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE credit_packages ENABLE ROW LEVEL SECURITY;

-- Tout le monde peut lire les packs actifs
CREATE POLICY "Public read active packages"
    ON credit_packages FOR SELECT
    USING (is_active = TRUE);

-- Seul le service role (backend) peut insérer/modifier/supprimer
-- (pas besoin de policy ici car le backend utilise la service key qui bypass RLS)
