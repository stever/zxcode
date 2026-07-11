-- Project folders: per-user named groups of projects. A folder is private by
-- default; a public folder groups the owner's public projects on their public
-- profile. Projects keep their own is_public — the folder flag only controls
-- visibility of the grouping itself.

CREATE TABLE public.project_folder (
    folder_id uuid DEFAULT gen_random_uuid() NOT NULL,
    owner_user_id uuid NOT NULL,
    name text NOT NULL,
    is_public boolean DEFAULT false NOT NULL,
    display_order integer DEFAULT 0,
    created_at timestamp(6) with time zone DEFAULT now() NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT now() NOT NULL,
    CONSTRAINT project_folder_pkey PRIMARY KEY (folder_id),
    CONSTRAINT project_folder_owner_user_id_fkey FOREIGN KEY (owner_user_id)
        REFERENCES public."user"(user_id) ON UPDATE RESTRICT ON DELETE CASCADE,
    CONSTRAINT project_folder_owner_name_key UNIQUE (owner_user_id, name),
    -- Target of the composite FK from project below.
    CONSTRAINT project_folder_id_owner_key UNIQUE (folder_id, owner_user_id),
    CONSTRAINT project_folder_name_check CHECK (btrim(name) <> '' AND char_length(name) <= 64)
);
COMMENT ON TABLE public.project_folder IS 'Per-user named groups of projects';
COMMENT ON COLUMN public.project_folder.is_public IS 'Whether the folder grouping is visible to other users; the projects inside keep their own is_public';

CREATE INDEX idx_project_folder_display_order ON public.project_folder(owner_user_id, display_order);
CREATE INDEX project_folder_is_public_idx ON public.project_folder(is_public) WHERE is_public = true;

CREATE TRIGGER set_public_project_folder_updated_at BEFORE UPDATE ON public.project_folder
    FOR EACH ROW EXECUTE PROCEDURE public.set_current_timestamp_updated_at();
COMMENT ON TRIGGER set_public_project_folder_updated_at ON public.project_folder
    IS 'trigger to set value of column "updated_at" to current timestamp on row update';

ALTER TABLE public.project ADD COLUMN folder_id uuid;
COMMENT ON COLUMN public.project.folder_id IS 'Folder the project is filed under, owned by the same user; null when unfiled';

-- The composite reference makes "a project can only sit in a folder owned by
-- the project''s owner" a database invariant. Deleting a folder unfiles its
-- projects: the column-targeted SET NULL (Postgres 15+) clears folder_id
-- without touching owner_user_id.
ALTER TABLE public.project
    ADD CONSTRAINT project_folder_owner_fkey FOREIGN KEY (folder_id, owner_user_id)
        REFERENCES public.project_folder(folder_id, owner_user_id)
        ON UPDATE RESTRICT ON DELETE SET NULL (folder_id);

CREATE INDEX idx_project_folder ON public.project(folder_id) WHERE folder_id IS NOT NULL;
