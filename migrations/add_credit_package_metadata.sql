ALTER TABLE public.credit_packages
ADD COLUMN IF NOT EXISTS yearly_price NUMERIC(10, 2),
ADD COLUMN IF NOT EXISTS is_trial BOOLEAN DEFAULT FALSE,
ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '[]'::jsonb;

UPDATE public.credit_packages
SET features = CASE id
    WHEN 'pack_100' THEN '["100 AI generations", "Access to all models", "Credits never expire"]'::jsonb
    WHEN 'pack_500' THEN '["500 AI generations", "Access to all models", "Priority queue", "Credits never expire"]'::jsonb
    WHEN 'pack_1000' THEN '["1000 AI generations", "Access to all models", "Priority queue", "Batch generation", "Credits never expire"]'::jsonb
    ELSE COALESCE(features, '[]'::jsonb)
END
WHERE features IS NULL OR features = '[]'::jsonb;
