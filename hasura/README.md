# Hasura Configuration & Migrations

This directory contains the Hasura GraphQL engine configuration, database migrations, and metadata for the Code · ZX Play.orgr project.

## Directory Structure

```
hasura/
├── config.yaml           # Hasura CLI configuration
├── metadata/            # Hasura metadata (permissions, relationships, etc.)
├── migrations/          # Database schema migrations
│   └── default/        # Migrations for the default database
│       └── [timestamp]_[name]/
│           ├── up.sql   # Migration to apply
│           └── down.sql # Migration rollback (optional)
└── README.md           # This file
```

## How Migrations Work

### Automatic Migration System

This project uses Hasura's **automatic migration system** via Docker. The `docker-compose.yaml` file uses a special Hasura image that automatically applies migrations on startup:

```yaml
image: hasura/graphql-engine:latest.cli-migrations-v3
```

### Development Workflow

1. **Starting the environment**: When you run `docker compose up`, Hasura automatically:

   - Checks the `hdb_catalog.schema_migrations` table to see which migrations have been applied
   - Applies any new migrations found in `hasura/migrations/default/` in timestamp order
   - Applies metadata from `hasura/metadata/`

2. **The migrations are applied automatically** - no manual intervention needed!

### Production Deployment

1. **GitHub Actions** builds Docker images when you push to the main branch
2. The production Hasura container includes your migrations and metadata
3. When deployed, the container automatically applies any new migrations on startup
4. Migrations are tracked, so they only run once per database

## Creating New Migrations

### Option 1: Manual Migration Files (Simple)

Create a new migration directory with timestamp and descriptive name:

```bash
# Generate timestamp
TIMESTAMP=$(date +%s)000

# Create migration directory
mkdir -p hasura/migrations/default/${TIMESTAMP}_your_migration_name

# Create up.sql file
cat > hasura/migrations/default/${TIMESTAMP}_your_migration_name/up.sql << 'EOF'
-- Your SQL goes here
ALTER TABLE public.user ADD COLUMN new_field text;
EOF

# Optionally create down.sql for rollback
cat > hasura/migrations/default/${TIMESTAMP}_your_migration_name/down.sql << 'EOF'
-- Rollback SQL
ALTER TABLE public.user DROP COLUMN new_field;
EOF
```

### Option 2: Using Hasura CLI (Advanced)

If you need more advanced migration management:

```bash
# Install Hasura CLI (one-time setup)
curl -L https://github.com/hasura/graphql-engine/raw/stable/cli/get.sh | bash

# Create a new migration
hasura migrate create your_migration_name \
  --database-name default \
  --endpoint http://localhost:4000 \
  --admin-secret hasurapassword

# This creates: migrations/default/[timestamp]_your_migration_name/up.sql
# Edit the file with your SQL, then apply:

# Apply migrations (usually automatic via Docker, but can be done manually)
hasura migrate apply \
  --database-name default \
  --endpoint http://localhost:4000 \
  --admin-secret hasurapassword
```

## Migration Best Practices

### 1. Migration Ordering

- Migrations run in timestamp order
- Each migration should be atomic and independent
- Never modify existing migration files after they've been committed

### 2. Safe Migration Pattern

For adding NOT NULL columns or constraints:

```sql
-- Migration 1: Add nullable column
ALTER TABLE public.user ADD COLUMN slug text;

-- Migration 2: Populate data (in application code or separate migration)
UPDATE public.user SET slug = lower(regexp_replace(username, '[^a-z0-9]+', '-', 'g'));

-- Migration 3: Add constraints
ALTER TABLE public.user ALTER COLUMN slug SET NOT NULL;
CREATE UNIQUE INDEX user_slug_key ON public.user(slug);
```

### 3. Testing Migrations

1. Always test migrations locally first
2. Ensure down migrations work (if provided)
3. Check that migrations are idempotent where possible

## Metadata Management

### Updating Permissions

Metadata changes (permissions, relationships, etc.) are in `hasura/metadata/`. These are automatically applied alongside migrations.

To modify metadata:

1. Edit the YAML files in `metadata/databases/default/tables/`
2. Restart Hasura to apply changes

Example: Adding a column to update permissions:

```yaml
# metadata/databases/default/tables/public_project.yaml
update_permissions:
  - role: zxplay-user
    permission:
      columns:
        - code
        - title
        - is_public # Add new column here
```

## Common Tasks

### Check Migration Status

Connect to Hasura Console at http://localhost:4000 and check the migrations tab, or query directly:

```sql
SELECT version, name, executed_at
FROM hdb_catalog.schema_migrations
ORDER BY version DESC;
```

### Reset Database (Development Only!)

```bash
# Stop containers
docker compose down

# Remove volume
docker volume rm zxcoder_pg_data

# Restart - all migrations will reapply
docker compose up -d
```

### Add a New Table

```sql
-- migrations/default/[timestamp]_create_comments/up.sql
CREATE TABLE public.comment (
    comment_id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
    project_id uuid NOT NULL REFERENCES public.project(project_id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES public.user(user_id),
    content text NOT NULL,
    created_at timestamptz DEFAULT now()
);

-- Create index for queries
CREATE INDEX comment_project_id_idx ON public.comment(project_id);
```

## Troubleshooting

### Migrations Not Applying

1. Check Docker logs: `docker compose logs hasura`
2. Ensure migration files have correct permissions
3. Check for SQL syntax errors in migration files

### Rollback a Migration

```bash
# Only if using Hasura CLI and down.sql exists
hasura migrate apply --version [version] --type down \
  --database-name default \
  --endpoint http://localhost:4000 \
  --admin-secret hasurapassword
```

### Migration Conflicts

If you have conflicting migrations (same timestamp):

1. Rename one migration folder with a different timestamp
2. Ensure the SQL operations don't conflict
3. Restart Hasura

## Environment Variables

The following environment variables control Hasura (set in `.env`):

- `HASURA_DATABASE_URL`: PostgreSQL connection string
- `HASURA_ADMIN_SECRET`: Admin secret for Hasura console
- `HASURA_JWT_SECRET`: JWT secret for authentication
- `HASURA_ENABLE_CONSOLE`: Enable/disable Hasura console
- `HASURA_GRAPHQL_DEV_MODE`: Enable development mode features

## Security Notes

1. **Never commit `.env` files** with production secrets
2. **Migration files are visible in the repo** - don't put sensitive data in migrations
3. **Use environment variables** for any configuration that varies by environment
4. **Test migrations thoroughly** before applying to production

## Resources

- [Hasura Migrations Documentation](https://hasura.io/docs/latest/migrations-metadata-seeds/migrations-metadata-setup/)
- [Hasura CLI Reference](https://hasura.io/docs/latest/hasura-cli/commands/index/)
- [SQL Migration Best Practices](https://hasura.io/docs/latest/migrations-metadata-seeds/migrations-metadata-best-practices/)
