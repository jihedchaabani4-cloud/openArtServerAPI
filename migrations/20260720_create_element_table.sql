-- Migration: Create public.element Table for AI Element Reference System (Option B)

CREATE TABLE IF NOT EXISTS public.element (
  id UUID NOT NULL DEFAULT gen_random_uuid(),
  workflow_id UUID NOT NULL,
  generation_config_id UUID NOT NULL,
  primary_media_id UUID,
  
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Product',
  description TEXT,
  
  master_identity TEXT NOT NULL,
  consistency_rules JSONB NOT NULL DEFAULT '[]'::jsonb,
  source_images JSONB NOT NULL DEFAULT '[]'::jsonb,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  version INT NOT NULL DEFAULT 1,
  
  create_time TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT element_pkey PRIMARY KEY (id),
  CONSTRAINT element_workflow_id_fkey 
    FOREIGN KEY (workflow_id) REFERENCES public.workflow(id) ON DELETE CASCADE,
  CONSTRAINT element_generation_config_id_fkey 
    FOREIGN KEY (generation_config_id) REFERENCES public.generation_config(id) ON DELETE CASCADE,
  CONSTRAINT element_primary_media_id_fkey 
    FOREIGN KEY (primary_media_id) REFERENCES public.media(id) ON DELETE SET NULL
);

-- Index for efficient lookup by workflow_id
CREATE INDEX IF NOT EXISTS idx_element_workflow_id ON public.element(workflow_id);
