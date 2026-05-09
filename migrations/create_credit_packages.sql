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
    variant_id    TEXT,                      -- Lemon Squeezy Variant ID
    checkout_url  TEXT,                      -- URL de checkout Lemon Squeezy
    popular       BOOLEAN DEFAULT FALSE,     -- badge "Popular" sur l'UI
    is_active     BOOLEAN DEFAULT TRUE,      -- FALSE = caché sans supprimer
    sort_order    INTEGER DEFAULT 0,         -- ordre d'affichage
    description   TEXT,                     -- description optionnelle
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

INSERT INTO credit_packages (id, label, credits, price, variant_id, checkout_url, popular, sort_order, description) VALUES
(
    'pack_100',
    'Starter Pack',
    100,
    4.99,
    'REPLACE_WITH_LS_VARIANT_ID_100',
    'https://your-store.lemonsqueezy.com/checkout/buy/REPLACE_WITH_VARIANT_ID_100',
    FALSE,
    1,
    'Perfect to get started'
),
(
    'pack_500',
    'Creator Pack',
    500,
    19.99,
    'REPLACE_WITH_LS_VARIANT_ID_500',
    'https://your-store.lemonsqueezy.com/checkout/buy/REPLACE_WITH_VARIANT_ID_500',
    TRUE,   -- badge "Popular"
    2,
    'Most popular — best value for creators'
),
(
    'pack_1000',
    'Studio Pack',
    1000,
    34.99,
    'REPLACE_WITH_LS_VARIANT_ID_1000',
    'https://your-store.lemonsqueezy.com/checkout/buy/REPLACE_WITH_VARIANT_ID_1000',
    FALSE,
    3,
    'For power users and studios'
)
ON CONFLICT (id) DO UPDATE SET
    label        = EXCLUDED.label,
    credits      = EXCLUDED.credits,
    price        = EXCLUDED.price,
    variant_id   = EXCLUDED.variant_id,
    checkout_url = EXCLUDED.checkout_url,
    popular      = EXCLUDED.popular,
    sort_order   = EXCLUDED.sort_order,
    description  = EXCLUDED.description;

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
