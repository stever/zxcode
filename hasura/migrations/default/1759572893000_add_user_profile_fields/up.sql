-- Add slug and profile fields to user table
ALTER TABLE public.user
ADD COLUMN IF NOT EXISTS slug text,
ADD COLUMN IF NOT EXISTS profile_is_public boolean NOT NULL DEFAULT true,
ADD COLUMN IF NOT EXISTS bio text;

-- Add slug field to project table
ALTER TABLE public.project
ADD COLUMN IF NOT EXISTS slug text;

-- Create temporary function to generate slugs
CREATE OR REPLACE FUNCTION generate_slug(input_text text)
RETURNS text AS $$
BEGIN
  -- Convert to lowercase, replace non-alphanumeric with hyphens
  -- Remove leading/trailing hyphens, collapse multiple hyphens
  RETURN regexp_replace(
    regexp_replace(
      regexp_replace(
        lower(input_text),
        '[^a-z0-9]+', '-', 'g'
      ),
      '^-+|-+$', '', 'g'
    ),
    '-+', '-', 'g'
  );
END;
$$ LANGUAGE plpgsql;

-- Generate slugs for existing users from username
UPDATE public.user
SET slug = generate_slug(username)
WHERE slug IS NULL;

-- Generate slugs for existing projects from title
-- Add row number suffix if duplicates exist within same owner
WITH numbered_projects AS (
  SELECT
    project_id,
    owner_user_id,
    title,
    generate_slug(title) as base_slug,
    ROW_NUMBER() OVER (
      PARTITION BY owner_user_id, generate_slug(title)
      ORDER BY created_at
    ) as rn
  FROM public.project
  WHERE slug IS NULL
)
UPDATE public.project p
SET slug = CASE
  WHEN np.rn = 1 THEN np.base_slug
  ELSE np.base_slug || '-' || np.rn
END
FROM numbered_projects np
WHERE p.project_id = np.project_id;

-- Drop the temporary function
DROP FUNCTION generate_slug(text);