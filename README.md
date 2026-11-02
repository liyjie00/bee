# Bee

Open-source, self-hostable collaborative documents (Quip-style): real-time
editing, Markdown, version history, inline comments, folder tree, and
private / member / public-link sharing.

## Layout

| Path | What |
| --- | --- |
| `apps/api` | Fastify HTTP API: auth, workspaces, folders, docs, sharing, comments, versions |
| `apps/collab` | Hocuspocus (Yjs) collaboration server, authorizes via `apps/api` |
| `apps/web` | Web client |
| `packages/db` | Drizzle schema + SQL migrations (PostgreSQL) |
| `packages/shared` | Shared types, roles and permission logic |
| `packages/editor` | Tiptap editor extensions shared by web and collab |

## Ports

Public: **8420** (Caddy) → `/api/*` api:8421, `/collab*` collab:8422, `/*` web:8423.
Dev Postgres: `localhost:54329`.

## Quick start (self-host)

```bash
cp .env.example .env   # edit SESSION_SECRET / COLLAB_SECRET
docker compose up -d --build
```

## Development

```bash
corepack enable
pnpm install
docker compose up -d postgres
pnpm db:migrate
pnpm dev
```

## License

AGPL-3.0-only. Contributions require agreeing to [CLA.md](CLA.md).
