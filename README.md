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

Public: **7070** (Caddy, config inline in `docker-compose.yml`) → `/api/*` api:8421, `/collab*` collab:1234, `/*` web:8423.
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

## Production on a Mac mini (bee.zippyzoo.dev)

The reference deployment runs the same `docker-compose.yml` on a Mac mini
(OrbStack or Docker Desktop) behind a Cloudflare Tunnel:

1. On the Mac mini, install a Docker runtime and `cloudflared`, and run the
   tunnel connector from the Cloudflare dashboard (Zero Trust → Networks →
   Tunnels). Add a public hostname `bee.zippyzoo.dev` → `http://localhost:7070`.
2. From a development machine with SSH access (`ssh mac-mini` must work):

   ```bash
   deploy/sync.sh
   ```

   This refuses uncommitted or non-`main` work, runs typecheck and tests
   locally (needs `docker compose up -d postgres`), ships `git archive HEAD`
   to `~/Documents/bee` on the mini, creates `.env` there with fresh secrets
   on first deploy (kept afterwards), then runs `docker compose up -d --build`
   and waits for `http://localhost:7070/api/health`.
   Override the target with `BEE_DEPLOY_HOST` / `BEE_DEPLOY_DIR`.

Data lives in the `bee_pgdata` and `bee_uploads` docker volumes on the mini.
Back them up with e.g. `docker compose exec postgres pg_dump -U bee bee > backup.sql`.

## Configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `BEE_PUBLIC_URL` | `http://localhost:7070` | Used for share links, secure cookies and the CSRF origin check |
| `SESSION_SECRET`, `COLLAB_SECRET` | required | Long random strings |
| `ALLOWED_ORIGINS` | `http://localhost:7070` | Extra origins allowed to make cookie-authenticated requests |
| `ALLOW_REGISTRATION` | `true` | Set `false` to close sign-ups |
| `MAX_UPLOAD_MB` | `25` | Per-file upload limit |
| `GUEST_COMMENT_RATE_LIMIT` | `5` | Guest (no sign-in) comments per IP per minute |
| `GUEST_COMMENT_HOURLY_LIMIT` | `60` | Guest comments per share link per hour |
| `BEE_PORT` | `7070` | Host port of the proxy |

## License

AGPL-3.0-only. Contributions require agreeing to [CLA.md](CLA.md).
