-- Rollback: Remove constraints and indexes
DROP INDEX IF EXISTS project_is_public_idx;
DROP INDEX IF EXISTS user_profile_is_public_idx;
DROP INDEX IF EXISTS project_owner_slug_key;
DROP INDEX IF EXISTS user_slug_key;

ALTER TABLE public.project
ALTER COLUMN slug DROP NOT NULL;

ALTER TABLE public.user
ALTER COLUMN slug DROP NOT NULL;