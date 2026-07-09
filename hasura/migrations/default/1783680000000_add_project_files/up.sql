-- Additional source files and binary assets belonging to a project. The main
-- source stays in project.code; these rows are the extra files (language
-- includes, INCBIN data, etc.) staged into the compile working directory
-- alongside it. Binary assets are stored base64-encoded with is_binary set.
CREATE TABLE public.project_file (
    file_id uuid DEFAULT public.gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    name text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    is_binary boolean DEFAULT false NOT NULL,
    created_at timestamp(6) with time zone DEFAULT now() NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_file_pkey PRIMARY KEY (file_id),
    CONSTRAINT project_file_project_id_fkey FOREIGN KEY (project_id)
        REFERENCES public.project(project_id) ON DELETE CASCADE,
    CONSTRAINT project_file_name_unique UNIQUE (project_id, name),
    -- Names become real filenames in the compile services' working
    -- directories, so keep them to a safe charset with no path separators.
    CONSTRAINT project_file_name_check CHECK (name ~ '^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$'),
    -- 256KB cap per file (base64 for binaries, so ~192KB of raw asset data).
    CONSTRAINT project_file_content_size_check CHECK (octet_length(content) <= 262144)
);

CREATE INDEX idx_project_file_project ON public.project_file(project_id);

CREATE TRIGGER set_public_project_file_updated_at BEFORE UPDATE ON public.project_file
    FOR EACH ROW EXECUTE PROCEDURE public.set_current_timestamp_updated_at();
COMMENT ON TRIGGER set_public_project_file_updated_at ON public.project_file
    IS 'trigger to set value of column "updated_at" to current timestamp on row update';

-- Cap files per project at the database layer. The UI and the compile
-- services enforce the same limit, but only this stops a client talking to
-- GraphQL directly from bulk-inserting rows (storage abuse). The parent row
-- is locked first so concurrent inserts serialise instead of racing past
-- the count.
CREATE FUNCTION public.enforce_project_file_limit() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM 1 FROM public.project WHERE project_id = NEW.project_id FOR UPDATE;
    IF (SELECT COUNT(*) FROM public.project_file WHERE project_id = NEW.project_id) >= 32 THEN
        RAISE EXCEPTION 'A project can hold at most 32 additional files';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_project_file_limit BEFORE INSERT ON public.project_file
    FOR EACH ROW EXECUTE PROCEDURE public.enforce_project_file_limit();
COMMENT ON TRIGGER enforce_project_file_limit ON public.project_file
    IS 'trigger to cap additional files per project at 32';

-- Screenshot/GIF cache keys derive from project.updated_at, so any file
-- change must touch the parent project or previews would serve stale
-- renders forever (the project row's own BEFORE UPDATE trigger stamps the
-- actual timestamp).
CREATE FUNCTION public.touch_project_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE public.project SET updated_at = NOW()
        WHERE project_id = COALESCE(NEW.project_id, OLD.project_id);
    RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER touch_project_on_file_change
    AFTER INSERT OR UPDATE OR DELETE ON public.project_file
    FOR EACH ROW EXECUTE PROCEDURE public.touch_project_updated_at();
COMMENT ON TRIGGER touch_project_on_file_change ON public.project_file
    IS 'trigger to bump the parent project''s updated_at when its files change';

COMMENT ON TABLE public.project_file IS 'Additional source files and assets belonging to a project';
COMMENT ON COLUMN public.project_file.name IS 'Filename within the project, unique per project, no path separators';
COMMENT ON COLUMN public.project_file.content IS 'File content: text as-is, binary assets base64-encoded';
COMMENT ON COLUMN public.project_file.is_binary IS 'True when content is a base64-encoded binary asset';
