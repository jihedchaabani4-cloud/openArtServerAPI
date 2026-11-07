-- Migration Draft: 20261019030100_drop_profiles_credits.sql
-- Description: Drop obsolete duplicate column profiles.credits (RESTRICT mode - no CASCADE).
-- Pre-conditions: wallets.balance is authoritative; authController no longer writes credits.
-- Safety: Non-destructive to ledger data; wallets table preserves all credit history.

BEGIN;

-- Drop dead credits column on public.profiles without CASCADE (RESTRICT)
-- PostgreSQL will abort if any view, rule, trigger, or foreign key depends on this column.
ALTER TABLE public.profiles
  DROP COLUMN IF EXISTS credits;

COMMIT;
