-- Drop indexes
DROP INDEX IF EXISTS public.idx_user_follows_created_at;
DROP INDEX IF EXISTS public.idx_user_follows_following;
DROP INDEX IF EXISTS public.idx_user_follows_follower;

-- Drop user_follows table
DROP TABLE IF EXISTS public.user_follows;