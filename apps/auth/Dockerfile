# Build context is apps/auth (see .github/workflows/publish-containers.yml).
FROM node:22-slim

WORKDIR /app

# Install this service's own dependencies (not workspace-hoisted).
COPY package.json ./
RUN npm install --no-audit --no-fund

COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["npx", "tsx", "src/index.ts"]
