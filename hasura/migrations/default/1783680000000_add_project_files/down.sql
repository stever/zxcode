DROP TRIGGER IF EXISTS touch_project_on_file_change ON public.project_file;
DROP FUNCTION IF EXISTS public.touch_project_updated_at();
DROP TRIGGER IF EXISTS enforce_project_file_limit ON public.project_file;
DROP FUNCTION IF EXISTS public.enforce_project_file_limit();
DROP TRIGGER IF EXISTS set_public_project_file_updated_at ON public.project_file;
DROP INDEX IF EXISTS public.idx_project_file_project;
DROP TABLE IF EXISTS public.project_file;
