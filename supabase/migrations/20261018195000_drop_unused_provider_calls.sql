-- Migration: 20261018195000_drop_unused_provider_calls.sql
-- Description: Drop unused legacy table public.provider_calls.
-- Evidence: Table has 0 rows, 0 foreign keys, 0 RLS policies, 0 triggers,
-- and 0 runtime code references across apiOpenArt and my-app.
-- Idempotency is managed by BullMQ job IDs, transaction reference IDs, and node output caches.

DROP TABLE IF EXISTS public.provider_calls CASCADE;
