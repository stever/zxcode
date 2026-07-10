-- Optional folder path per file. The relative path folder/name is the file's
-- identity everywhere: how source code references it (INCLUDE, #include,
-- LOAD), where the compile services stage it in the workdir, where the Next
-- emulator stages it on the SD card, and where it sits in the downloaded
-- project ZIP — so the bundle works unchanged when unzipped onto a real card.
ALTER TABLE public.project_file
    ADD COLUMN folder text DEFAULT ''::text NOT NULL;

-- Empty means the project root. Segments use the same safe charset as name
-- (no leading dot, so no '.'/'..' segments and no traversal when staged as
-- real directories), joined by single slashes, capped so folder/name stays a
-- reasonable path.
ALTER TABLE public.project_file
    ADD CONSTRAINT project_file_folder_check CHECK (
        folder = '' OR (
            char_length(folder) <= 128
            AND folder ~ '^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}(/[A-Za-z0-9_-][A-Za-z0-9._-]{0,63})*$'
        )
    );

-- The full path is the identity, so uniqueness moves from bare name to
-- (folder, name): different folders may hold the same base name.
ALTER TABLE public.project_file
    DROP CONSTRAINT project_file_name_unique;
ALTER TABLE public.project_file
    ADD CONSTRAINT project_file_path_unique UNIQUE (project_id, folder, name);

COMMENT ON COLUMN public.project_file.folder
    IS 'Optional folder path (seg/seg); folder/name is the file''s relative path in compile staging, SD-card staging and the download ZIP';
COMMENT ON COLUMN public.project_file.name
    IS 'Filename within its folder; the relative path folder/name is unique per project';
