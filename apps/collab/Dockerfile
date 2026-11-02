# Build context: repository root.
FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY patches patches
COPY packages/editor/package.json packages/editor/
COPY apps/collab/package.json apps/collab/
RUN pnpm install --frozen-lockfile --filter @bee/collab...
COPY packages/editor packages/editor
COPY apps/collab apps/collab
RUN pnpm --filter @bee/editor build && pnpm --filter @bee/collab build
# Self-contained production install: built workspace packages + prod dependencies only.
RUN pnpm --filter @bee/collab --prod --config.auto-install-peers=false deploy --legacy /out

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
USER node
EXPOSE 1234
HEALTHCHECK --interval=30s --timeout=3s CMD ["node", "-e", "fetch('http://127.0.0.1:1234/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
