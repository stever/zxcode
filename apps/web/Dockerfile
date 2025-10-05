FROM caddy:2 AS base
COPY apps/web/Caddyfile /etc/caddy/Caddyfile

FROM node:22 AS npmbuild
WORKDIR /project
COPY . .
RUN npm install --legacy-peer-deps
RUN npm run build

FROM base AS final
COPY --from=npmbuild /project/apps/web/public /srv
