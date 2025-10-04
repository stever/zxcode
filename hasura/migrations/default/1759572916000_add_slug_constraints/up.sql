-- Add NOT NULL constraints and unique indexes for slugs
-- This is a separate migration to ensure data is populated first

-- Make user slug required and unique
ALTER TABLE public.user
ALTER COLUMN slug SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS user_slug_key
ON public.user(slug);

-- Make project slug required
ALTER TABLE public.project
ALTER COLUMN slug SET NOT NULL;

-- Create unique index for project slugs (unique per user)
CREATE UNIQUE INDEX IF NOT EXISTS project_owner_slug_key
ON public.project(owner_user_id, slug);

-- Add index for profile visibility queries
CREATE INDEX IF NOT EXISTS user_profile_is_public_idx
ON public.user(profile_is_public)
WHERE profile_is_public = true;

-- Add index for public project queries
CREATE INDEX IF NOT EXISTS project_is_public_idx
ON public.project(is_public)
WHERE is_public = true;