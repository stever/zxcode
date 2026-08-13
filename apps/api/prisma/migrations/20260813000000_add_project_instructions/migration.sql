-- "About this program": owner-written instructions and commentary shown to
-- anyone viewing the project (markdown). One free-text field rather than
-- separate instructions/commentary columns — the author decides the shape.

ALTER TABLE public.project ADD COLUMN instructions text DEFAULT '' NOT NULL;
COMMENT ON COLUMN public.project.instructions IS 'Owner-written notes shown to viewers: usage instructions and commentary (markdown)';

-- Same defensive cap style as project_folder's name check: the IDE limits
-- the field too, this stops a runaway payload at the source of truth.
ALTER TABLE public.project
    ADD CONSTRAINT project_instructions_check CHECK (char_length(instructions) <= 10000);
