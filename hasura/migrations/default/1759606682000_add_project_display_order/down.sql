-- Remove the index
DROP INDEX IF EXISTS public.idx_project_display_order;

-- Remove display_order column from project table
ALTER TABLE public.project
DROP COLUMN IF EXISTS display_order;