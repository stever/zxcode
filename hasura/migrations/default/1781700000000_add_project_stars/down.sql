-- Drop indexes
DROP INDEX IF EXISTS public.idx_project_star_created_at;
DROP INDEX IF EXISTS public.idx_project_star_project;
DROP INDEX IF EXISTS public.idx_project_star_user;

-- Drop project_star table
DROP TABLE IF EXISTS public.project_star;
