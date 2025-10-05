-- Add avatar fields to user table
ALTER TABLE public.user
ADD COLUMN IF NOT EXISTS avatar_variant integer DEFAULT 0,
ADD COLUMN IF NOT EXISTS custom_avatar_data jsonb;

-- Add comments for documentation
COMMENT ON COLUMN public.user.avatar_variant IS 'Avatar variant number (0-199) or special value for custom avatar';
COMMENT ON COLUMN public.user.custom_avatar_data IS 'Custom pixel art avatar data as 8x8 grid of color indices';

-- Create index on avatar_variant for potential future filtering
CREATE INDEX IF NOT EXISTS idx_user_avatar_variant ON public.user(avatar_variant);