# Build context is the repo root for consistency with the other service images.
FROM node:22-slim

WORKDIR /app

COPY apps/mastodon-bot/package.json ./
RUN npm install --no-audit --no-fund

COPY apps/mastodon-bot/ ./

ENV STATE_FILE=/data/state.json
CMD ["npx", "tsx", "src/index.ts"]
