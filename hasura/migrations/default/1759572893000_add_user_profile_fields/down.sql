-- Rollback: Remove added columns
ALTER TABLE public.project
DROP COLUMN IF EXISTS slug;

ALTER TABLE public.user
DROP COLUMN IF EXISTS slug,
DROP COLUMN IF EXISTS profile_is_public,
DROP COLUMN IF EXISTS bio;