-- Migration: 20261018163500_sweep_stale_processing_media.sql
-- Description: Mark abandoned processing placeholders older than 2 hours as failed.
--              Resolves orphaned processing placeholders from worker drops.

UPDATE public.media
SET 
    status = 'failed',
    error_message = 'Generation execution timed out. Placeholder expired.'
WHERE 
    status = 'processing' 
    AND url IS NULL 
    AND create_time < NOW() - INTERVAL '2 hours';
