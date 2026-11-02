# Build context: repository root.
FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
# Manifests first so the install layer stays cached until dependencies change.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY patches patches
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/editor/package.json packages/editor/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter "@bee/api..."
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY packages/editor packages/editor
COPY apps/api apps/api
RUN pnpm --filter "@bee/api..." run build

FROM node:24-bookworm-slim
RUN corepack enable
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=build /repo /repo
WORKDIR /repo/apps/api
EXPOSE 8421
CMD ["node", "dist/server.js"]
