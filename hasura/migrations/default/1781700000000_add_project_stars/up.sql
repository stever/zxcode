-- Create project_star table for tracking project favourites/stars
CREATE TABLE IF NOT EXISTS public.project_star (
    user_id UUID NOT NULL REFERENCES public."user"(user_id) ON DELETE CASCADE,
    project_id UUID NOT NULL REFERENCES public.project(project_id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (user_id, project_id)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_project_star_user ON public.project_star(user_id);
CREATE INDEX IF NOT EXISTS idx_project_star_project ON public.project_star(project_id);
CREATE INDEX IF NOT EXISTS idx_project_star_created_at ON public.project_star(created_at DESC);

-- Add comments to table
COMMENT ON TABLE public.project_star IS 'Stores project favourite/star relationships between users and projects';
COMMENT ON COLUMN public.project_star.user_id IS 'User who starred the project';
COMMENT ON COLUMN public.project_star.project_id IS 'Project that was starred';
COMMENT ON COLUMN public.project_star.created_at IS 'Timestamp when the project was starred';
