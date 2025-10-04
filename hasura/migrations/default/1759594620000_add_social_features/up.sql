-- Create user_follows table for tracking follow relationships
CREATE TABLE IF NOT EXISTS public.user_follows (
    follower_id UUID NOT NULL REFERENCES public."user"(user_id) ON DELETE CASCADE,
    following_id UUID NOT NULL REFERENCES public."user"(user_id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    PRIMARY KEY (follower_id, following_id),
    -- Ensure users can't follow themselves
    CONSTRAINT no_self_follow CHECK (follower_id != following_id)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_user_follows_follower ON public.user_follows(follower_id);
CREATE INDEX IF NOT EXISTS idx_user_follows_following ON public.user_follows(following_id);
CREATE INDEX IF NOT EXISTS idx_user_follows_created_at ON public.user_follows(created_at DESC);

-- Add comment to table
COMMENT ON TABLE public.user_follows IS 'Stores follow relationships between users';
COMMENT ON COLUMN public.user_follows.follower_id IS 'User who is following';
COMMENT ON COLUMN public.user_follows.following_id IS 'User who is being followed';
COMMENT ON COLUMN public.user_follows.created_at IS 'Timestamp when the follow relationship was created';