-- Rollback Draft: 20261019030100_drop_profiles_credits_rollback.sql
-- Description: Re-adds profiles.credits and backfills from authoritative wallets table.

BEGIN;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS credits INTEGER DEFAULT 0;

-- Backfill profile credits from authoritative wallets table
UPDATE public.profiles p
SET credits = w.balance
FROM public.wallets w
WHERE w.user_id = p.id;

COMMIT;
