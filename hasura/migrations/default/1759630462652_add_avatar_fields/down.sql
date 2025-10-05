-- Remove avatar fields from user table
DROP INDEX IF EXISTS idx_user_avatar_variant;

ALTER TABLE public.user
DROP COLUMN IF EXISTS avatar_variant,
DROP COLUMN IF EXISTS custom_avatar_data;