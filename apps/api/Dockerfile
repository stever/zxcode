# Build context is the repo root, matching the other service Dockerfiles.
FROM node:22-slim

# Prisma's query engine links against OpenSSL.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/apps/api

# Install this service's own dependencies (not workspace-hoisted).
COPY apps/api/package.json ./
RUN npm install --no-audit --no-fund

# Service source (prisma/ carries the schema and migrations used by both the
# api process and the one-shot migrate container).
COPY apps/api/ ./
RUN npx prisma generate

ENV PORT=8080
EXPOSE 8080

# The compose file runs this same image two ways: the one-shot api-migrate
# service overrides the command with `npx tsx src/migrate.ts`, and the api
# proper starts only after that exits cleanly.
CMD ["npx", "tsx", "src/index.ts"]
