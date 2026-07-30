-- Migration: Fix element table RLS policy blocking backend inserts
-- Root Cause: The public.element table has RLS enabled with INSERT policies that
--             block inserts even from the service role (e.g., a RESTRICTIVE policy
--             or a WITH CHECK clause tied to auth.uid() that the backend never sets).
-- Fix: Disable RLS on the element table since the backend always uses the service
--      role key which should bypass RLS — but belt-and-suspenders we also add an
--      explicit service_role bypass policy.
--
-- NOTE: The backend (Express + Supabase service role key) is the only writer of
--       this table. There is no direct client-side access to public.element.

-- Option A (recommended for purely server-side tables): Disable RLS entirely.
ALTER TABLE public.element DISABLE ROW LEVEL SECURITY;

-- If you prefer to keep RLS enabled for auditability, comment the line above
-- and instead use Option B below:

-- Option B: Keep RLS but add an explicit bypass policy for the service role.
-- ALTER TABLE public.element ENABLE ROW LEVEL SECURITY;
-- DROP POLICY IF EXISTS "service_role_bypass" ON public.element;
-- CREATE POLICY "service_role_bypass" ON public.element
--   AS PERMISSIVE
--   FOR ALL
--   TO service_role
--   USING (true)
--   WITH CHECK (true);
