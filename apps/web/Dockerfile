# Build context: repository root.
FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
# Manifests first so the install layer stays cached until dependencies change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY patches patches
COPY packages/shared/package.json packages/shared/
COPY packages/editor/package.json packages/editor/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter "@bee/web..."
COPY packages/shared packages/shared
COPY packages/editor packages/editor
COPY apps/web apps/web
# Builds @bee/shared and @bee/editor first (workspace deps), then the Vite bundle.
RUN pnpm --filter "@bee/web..." run build

# Static SPA served by Caddy; the public proxy in deploy/Caddyfile routes / here.
FROM caddy:2-alpine
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
ENV PORT=8423
EXPOSE 8423
