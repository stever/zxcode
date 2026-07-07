-- Target machine the project was last saved with. Stamped by the editor's
-- save/create mutations from the current machine selection, and read by
-- gif-service so screenshots render on the machine the program targets
-- (a Next-only program on a 48K freezes on the tape loader screen).
ALTER TABLE public.project
    ADD COLUMN machine text DEFAULT '48' NOT NULL,
    ADD CONSTRAINT project_machine_check CHECK (machine IN ('48', '128', 'next'));
COMMENT ON COLUMN public.project.machine IS 'Target machine the project was last saved with: 48, 128 or next';

-- The init migration created this trigger only on public.text, so
-- project.updated_at never changed after insert: screenshot cache keys
-- (server file key and the browser ?v= param) are derived from it, so
-- edited projects kept serving their first-ever screenshot forever.
CREATE TRIGGER set_public_project_updated_at BEFORE UPDATE ON public.project
    FOR EACH ROW EXECUTE PROCEDURE public.set_current_timestamp_updated_at();
COMMENT ON TRIGGER set_public_project_updated_at ON public.project
    IS 'trigger to set value of column "updated_at" to current timestamp on row update';
