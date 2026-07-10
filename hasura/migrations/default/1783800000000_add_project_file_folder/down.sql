-- Note: re-adding the bare-name unique constraint fails if any project holds
-- the same base name in two folders; resolve those rows first.
ALTER TABLE public.project_file DROP CONSTRAINT project_file_path_unique;
ALTER TABLE public.project_file ADD CONSTRAINT project_file_name_unique UNIQUE (project_id, name);
ALTER TABLE public.project_file DROP CONSTRAINT project_file_folder_check;
ALTER TABLE public.project_file DROP COLUMN folder;
COMMENT ON COLUMN public.project_file.name
    IS 'Filename within the project, unique per project, no path separators';
