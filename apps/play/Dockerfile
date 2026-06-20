FROM caddy:2 AS base
COPY apps/play/Caddyfile /etc/caddy/Caddyfile

FROM node:22 AS npmbuild
WORKDIR /project
# Build context is the repo root so the workspace + @zxplay/emulator are present.
COPY . .
RUN npm install --legacy-peer-deps
# Builds @zxplay/emulator then apps/play (its build script chains both).
RUN npm run build -w play

FROM base AS final
COPY --from=npmbuild /project/apps/play/public /srv
# Cache-bust the static bundle reference per build.
RUN sed -i "s|ver=0|ver=$(date +%s)|g" /srv/index.html
