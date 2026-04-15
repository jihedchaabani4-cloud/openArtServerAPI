-- Remove old separate error columns if they exist
ALTER TABLE generation_items
DROP COLUMN IF EXISTS error_code,
DROP COLUMN IF EXISTS error_status,
DROP COLUMN IF EXISTS error_step,
DROP COLUMN IF EXISTS error_message;

-- Add single JSONB error column
ALTER TABLE generation_items
ADD COLUMN IF NOT EXISTS error JSONB DEFAULT NULL;
