-- Add display_order column to project table for custom ordering
ALTER TABLE public.project
ADD COLUMN display_order integer DEFAULT 0;

-- Create an index on display_order for efficient sorting
CREATE INDEX idx_project_display_order ON public.project(owner_user_id, display_order);

-- Update existing projects with initial display order based on created_at
WITH numbered_projects AS (
  SELECT
    project_id,
    ROW_NUMBER() OVER (PARTITION BY owner_user_id ORDER BY created_at DESC) - 1 as new_order
  FROM public.project
)
UPDATE public.project p
SET display_order = np.new_order
FROM numbered_projects np
WHERE p.project_id = np.project_id;