-- Clean up objects only a Hasura-era database has. On a fresh database this
-- whole migration is a no-op.

-- Untracked legacy view from the original init migration: unused by any
-- consumer and it exposed email addresses.
DROP VIEW IF EXISTS public.v_projects;

-- Hasura's own catalogue (metadata, event log). Nothing reads it once the
-- graphql-engine container is gone.
DROP SCHEMA IF EXISTS hdb_catalog CASCADE;
