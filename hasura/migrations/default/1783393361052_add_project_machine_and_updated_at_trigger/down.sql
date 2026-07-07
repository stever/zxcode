DROP TRIGGER set_public_project_updated_at ON public.project;
ALTER TABLE public.project
    DROP CONSTRAINT project_machine_check,
    DROP COLUMN machine;
