-- Drop the existing constraint
ALTER TABLE public.workflow DROP CONSTRAINT IF EXISTS workflow_workflow_type_check;

-- Add the new constraint including 'PRODUCT'
ALTER TABLE public.workflow ADD CONSTRAINT workflow_workflow_type_check CHECK (
    (
        workflow_type = any (
            array[
                'GENERATION'::text,
                'CHARACTER'::text,
                'LOCATION'::text,
                'PRODUCT'::text
            ]
        )
    )
);
