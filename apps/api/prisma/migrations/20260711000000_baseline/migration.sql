-- Baseline: the net schema the Hasura migrations (hasura/migrations/default,
-- 1672066910249_init .. 1783800000000_add_project_file_folder) had built when
-- the backend moved to Prisma. On a database created by those migrations this
-- migration is marked applied without running (see src/migrate.ts); it only
-- executes on a fresh database.
--
-- Deliberately not recreated from the old init migration: the untracked
-- legacy view v_projects (unused, exposed email addresses).

-- gen_random_uuid() is a Postgres 13+ built-in; the extension keeps this
-- working on anything older and is harmless otherwise.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

SET check_function_bodies = false;

CREATE FUNCTION public.set_current_timestamp_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  _new record;
BEGIN
  _new := NEW;
  _new."updated_at" = NOW();
  RETURN _new;
END;
$$;

CREATE TABLE public."user" (
    user_id uuid DEFAULT gen_random_uuid() NOT NULL,
    username text NOT NULL,
    greeting_name text,
    full_name text,
    email_address text,
    created_at timestamp(6) with time zone DEFAULT now(),
    slug text NOT NULL,
    profile_is_public boolean DEFAULT true NOT NULL,
    bio text,
    avatar_variant integer DEFAULT 0,
    custom_avatar_data jsonb,
    CONSTRAINT user_pkey PRIMARY KEY (user_id),
    CONSTRAINT user_username_key UNIQUE (username),
    CONSTRAINT user_email_address_key UNIQUE (email_address)
);
COMMENT ON TABLE public."user" IS 'Authenticated user';
COMMENT ON COLUMN public."user".avatar_variant IS 'Avatar variant number (0-199) or special value for custom avatar';
COMMENT ON COLUMN public."user".custom_avatar_data IS 'Custom pixel art avatar data as 8x8 grid of color indices';

CREATE UNIQUE INDEX user_slug_key ON public."user"(slug);
CREATE INDEX user_profile_is_public_idx ON public."user"(profile_is_public) WHERE profile_is_public = true;
CREATE INDEX idx_user_avatar_variant ON public."user"(avatar_variant);

CREATE TABLE public.project (
    project_id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    code text DEFAULT ''::text NOT NULL,
    owner_user_id uuid,
    updated_at timestamp(6) with time zone DEFAULT now(),
    created_at timestamp(6) with time zone DEFAULT now(),
    lang text DEFAULT 'zxbasic'::text NOT NULL,
    is_public boolean DEFAULT false NOT NULL,
    slug text NOT NULL,
    display_order integer DEFAULT 0,
    machine text DEFAULT '48' NOT NULL,
    CONSTRAINT project_pkey PRIMARY KEY (project_id),
    CONSTRAINT project_owner_user_id_fkey FOREIGN KEY (owner_user_id)
        REFERENCES public."user"(user_id) ON UPDATE RESTRICT ON DELETE RESTRICT,
    CONSTRAINT project_machine_check CHECK (machine IN ('48', '128', 'next'))
);
COMMENT ON TABLE public.project IS 'Saved projects';
COMMENT ON COLUMN public.project.machine IS 'Target machine the project was last saved with: 48, 128 or next';

CREATE UNIQUE INDEX project_owner_slug_key ON public.project(owner_user_id, slug);
CREATE INDEX project_is_public_idx ON public.project(is_public) WHERE is_public = true;
CREATE INDEX idx_project_display_order ON public.project(owner_user_id, display_order);

CREATE TRIGGER set_public_project_updated_at BEFORE UPDATE ON public.project
    FOR EACH ROW EXECUTE PROCEDURE public.set_current_timestamp_updated_at();
COMMENT ON TRIGGER set_public_project_updated_at ON public.project
    IS 'trigger to set value of column "updated_at" to current timestamp on row update';

CREATE TABLE public.project_file (
    file_id uuid DEFAULT gen_random_uuid() NOT NULL,
    project_id uuid NOT NULL,
    name text NOT NULL,
    content text DEFAULT ''::text NOT NULL,
    is_binary boolean DEFAULT false NOT NULL,
    created_at timestamp(6) with time zone DEFAULT now() NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT now() NOT NULL,
    folder text DEFAULT ''::text NOT NULL,
    CONSTRAINT project_file_pkey PRIMARY KEY (file_id),
    CONSTRAINT project_file_project_id_fkey FOREIGN KEY (project_id)
        REFERENCES public.project(project_id) ON DELETE CASCADE,
    CONSTRAINT project_file_path_unique UNIQUE (project_id, folder, name),
    CONSTRAINT project_file_name_check CHECK (name ~ '^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$'),
    CONSTRAINT project_file_content_size_check CHECK (octet_length(content) <= 262144),
    CONSTRAINT project_file_folder_check CHECK (
        folder = '' OR (
            char_length(folder) <= 128
            AND folder ~ '^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}(/[A-Za-z0-9_-][A-Za-z0-9._-]{0,63})*$'
        )
    )
);
COMMENT ON TABLE public.project_file IS 'Additional source files and assets belonging to a project';
COMMENT ON COLUMN public.project_file.name IS 'Filename within its folder; the relative path folder/name is unique per project';
COMMENT ON COLUMN public.project_file.folder IS 'Optional folder path (seg/seg); folder/name is the file''s relative path in compile staging, SD-card staging and the download ZIP';
COMMENT ON COLUMN public.project_file.content IS 'File content: text as-is, binary assets base64-encoded';
COMMENT ON COLUMN public.project_file.is_binary IS 'True when content is a base64-encoded binary asset';

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

CREATE TABLE public.project_star (
    user_id uuid NOT NULL,
    project_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT project_star_pkey PRIMARY KEY (user_id, project_id),
    CONSTRAINT project_star_user_id_fkey FOREIGN KEY (user_id)
        REFERENCES public."user"(user_id) ON DELETE CASCADE,
    CONSTRAINT project_star_project_id_fkey FOREIGN KEY (project_id)
        REFERENCES public.project(project_id) ON DELETE CASCADE
);
COMMENT ON TABLE public.project_star IS 'Stores project favourite/star relationships between users and projects';
COMMENT ON COLUMN public.project_star.user_id IS 'User who starred the project';
COMMENT ON COLUMN public.project_star.project_id IS 'Project that was starred';
COMMENT ON COLUMN public.project_star.created_at IS 'Timestamp when the project was starred';

CREATE INDEX idx_project_star_user ON public.project_star(user_id);
CREATE INDEX idx_project_star_project ON public.project_star(project_id);
CREATE INDEX idx_project_star_created_at ON public.project_star(created_at DESC);

CREATE TABLE public.user_follows (
    follower_id uuid NOT NULL,
    following_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT user_follows_pkey PRIMARY KEY (follower_id, following_id),
    CONSTRAINT user_follows_follower_id_fkey FOREIGN KEY (follower_id)
        REFERENCES public."user"(user_id) ON DELETE CASCADE,
    CONSTRAINT user_follows_following_id_fkey FOREIGN KEY (following_id)
        REFERENCES public."user"(user_id) ON DELETE CASCADE,
    CONSTRAINT no_self_follow CHECK (follower_id != following_id)
);
COMMENT ON TABLE public.user_follows IS 'Stores follow relationships between users';
COMMENT ON COLUMN public.user_follows.follower_id IS 'User who is following';
COMMENT ON COLUMN public.user_follows.following_id IS 'User who is being followed';
COMMENT ON COLUMN public.user_follows.created_at IS 'Timestamp when the follow relationship was created';

CREATE INDEX idx_user_follows_follower ON public.user_follows(follower_id);
CREATE INDEX idx_user_follows_following ON public.user_follows(following_id);
CREATE INDEX idx_user_follows_created_at ON public.user_follows(created_at DESC);

CREATE TABLE public.session (
    session_id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    auth_token character varying(255) NOT NULL,
    created timestamp(6) with time zone NOT NULL,
    updated timestamp(6) with time zone,
    expires timestamp(6) with time zone NOT NULL,
    CONSTRAINT session_pkey PRIMARY KEY (session_id),
    CONSTRAINT session_auth_token_key UNIQUE (auth_token),
    CONSTRAINT session_user_id_fkey FOREIGN KEY (user_id)
        REFERENCES public."user"(user_id) ON UPDATE CASCADE ON DELETE CASCADE
);
COMMENT ON TABLE public.session IS 'Authenticated user sessions';

CREATE TABLE public.role (
    role_id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    created_at timestamp(6) with time zone DEFAULT now(),
    CONSTRAINT role_pkey PRIMARY KEY (role_id),
    CONSTRAINT role_name_key UNIQUE (name)
);
COMMENT ON TABLE public.role IS 'Named role assigned to some users';

CREATE TABLE public.user_role (
    user_id uuid NOT NULL,
    role_id uuid NOT NULL,
    created_at timestamp(6) with time zone DEFAULT now(),
    CONSTRAINT user_role_pkey PRIMARY KEY (user_id, role_id),
    CONSTRAINT user_role_user_id_fkey FOREIGN KEY (user_id)
        REFERENCES public."user"(user_id) ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT user_role_role_id_fkey FOREIGN KEY (role_id)
        REFERENCES public.role(role_id) ON UPDATE CASCADE ON DELETE CASCADE
);
COMMENT ON TABLE public.user_role IS 'User assigned to role. Added and removed but never updated.';

CREATE TABLE public.text (
    text_id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    lang text NOT NULL,
    text text NOT NULL,
    created_at timestamp(6) with time zone DEFAULT now() NOT NULL,
    updated_at timestamp(6) with time zone DEFAULT now() NOT NULL,
    CONSTRAINT text_pkey PRIMARY KEY (text_id),
    CONSTRAINT text_name_lang_key UNIQUE (name, lang)
);
COMMENT ON TABLE public.text IS 'Markdown page content';

CREATE TRIGGER set_public_text_updated_at BEFORE UPDATE ON public.text
    FOR EACH ROW EXECUTE PROCEDURE public.set_current_timestamp_updated_at();
COMMENT ON TRIGGER set_public_text_updated_at ON public.text
    IS 'trigger to set value of column "updated_at" to current timestamp on row update';
