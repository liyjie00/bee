# Build context: repository root.
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# Builds @bee/shared and @bee/editor first (workspace deps), then the Vite bundle.
RUN pnpm --filter "@bee/web..." run build

# Static SPA served by Caddy; the public proxy in deploy/Caddyfile routes / here.
FROM caddy:2-alpine
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
ENV PORT=8423
EXPOSE 8423
