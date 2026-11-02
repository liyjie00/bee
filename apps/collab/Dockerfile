# Build context: repository root.
FROM node:24-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json ./
COPY packages/editor/package.json packages/editor/
COPY apps/collab/package.json apps/collab/
RUN pnpm install --frozen-lockfile --filter @bee/collab...
COPY packages/editor packages/editor
COPY apps/collab apps/collab
RUN pnpm --filter @bee/editor build && pnpm --filter @bee/collab build \
  && pnpm install --frozen-lockfile --prod --filter @bee/collab...

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/apps/collab
USER node
EXPOSE 1234
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:1234/health || exit 1
CMD ["node", "dist/index.js"]
