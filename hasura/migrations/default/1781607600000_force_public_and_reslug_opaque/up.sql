-- Force all existing user profiles to public (opt-out model).
-- NOTE: profile_is_public already defaults to true; this also overrides any
-- profiles that were deliberately set private. This is intentional.
UPDATE public.user
SET profile_is_public = true
WHERE profile_is_public = false;

-- Replace auto-derived "auth0-" style slugs (and any slug still derived from an
-- opaque provider username such as "auth0|...", "google-oauth2|...") with a
-- friendly, speccy-themed handle, and give those accounts a display name.
--
-- We only touch accounts that never customised their handle: the slug must
-- still equal the value derived from the opaque username. Customised slugs and
-- non-opaque usernames are left untouched.
DO $$
DECLARE
  r RECORD;
  w1 text[] := ARRAY[
    'beeper','raster','attr','pixel','sprite','scanline','border','ink','paper',
    'bright','flash','loader','tape','micro','turbo','retro','neon','vector',
    'scroll','blitz','basic','rom','beam','clash'];
  w2 text[] := ARRAY[
    'wizard','runner','hacker','clash','byte','loop','coder','ghost','droid',
    'knight','racer','pilot','ranger','goblin','comet','falcon','glitch','demon',
    'crawler','smith','phantom','jumper','blaster','rebel'];
  derived_slug text;
  new_slug text;
  a text;
  b text;
  n int;
  attempts int;
BEGIN
  FOR r IN
    SELECT user_id, username, slug, greeting_name
    FROM public.user
    WHERE position('|' in username) > 0
  LOOP
    -- Slug as originally generated from the username (lowercase, non-alphanumeric
    -- collapsed to single hyphens, trimmed). Matches the auth service GenerateSlug.
    derived_slug := trim(both '-' from regexp_replace(lower(r.username), '[^a-z0-9]+', '-', 'g'));

    IF r.slug = derived_slug THEN
      attempts := 0;
      LOOP
        a := w1[1 + floor(random() * array_length(w1, 1))::int];
        b := w2[1 + floor(random() * array_length(w2, 1))::int];
        n := 10 + floor(random() * 9990)::int;  -- 2 to 4 digits
        new_slug := a || '-' || b || '-' || n;
        EXIT WHEN NOT EXISTS (SELECT 1 FROM public.user WHERE slug = new_slug);
        attempts := attempts + 1;
        IF attempts > 50 THEN
          RAISE EXCEPTION 'Could not generate a unique slug for user %', r.user_id;
        END IF;
      END LOOP;

      UPDATE public.user
      SET slug = new_slug,
          greeting_name = COALESCE(NULLIF(greeting_name, ''), initcap(a) || ' ' || initcap(b))
      WHERE user_id = r.user_id;
    END IF;
  END LOOP;
END $$;
