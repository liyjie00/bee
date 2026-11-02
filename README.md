# Bee

English | [简体中文](README.zh-CN.md)

Open-source, self-hostable collaborative documents (Quip-style): real-time
editing, Markdown, version history, inline comments, folder tree, whiteboards,
and private / member / public-link sharing. Bee is also a remote MCP server, so
Claude and other MCP clients can read and edit your documents.

A hosted instance runs at [bee.zippyzoo.dev](https://bee.zippyzoo.dev).

## Self-hosting

You need Docker with Compose v2 (Docker Desktop, OrbStack, or Docker Engine on
Linux). The whole stack (PostgreSQL, API, collaboration server, web client and a
Caddy proxy) runs from `docker-compose.yml`, and only the proxy port is exposed.

```bash
git clone <this repository> bee && cd bee
cp .env.example .env
# Set SESSION_SECRET and COLLAB_SECRET to long random strings, e.g.:
#   openssl rand -hex 32
# Set BEE_PUBLIC_URL to the origin people will open, e.g. https://docs.example.com
docker compose up -d --build
```

Then open `BEE_PUBLIC_URL` (default <http://localhost:7070>) and create the first
account. Database migrations run automatically when the API starts.

### Putting it on the internet

The proxy speaks plain HTTP on `BEE_PORT` (default 7070). Put TLS in front of it
with whatever you already use: a reverse proxy (Caddy, nginx, Traefik), a load
balancer, or a tunnel such as Cloudflare Tunnel pointing your hostname at
`http://localhost:7070`. The proxy must pass WebSocket upgrades for `/collab`.

Set `BEE_PUBLIC_URL` to the public `https://` origin. It is used for share
links, secure cookies, the CSRF origin check, and as the OAuth issuer of the MCP
server, so it must match what the browser sees. Once your own account exists you
can close sign-ups with `ALLOW_REGISTRATION=false`.

### Updating

```bash
git pull
docker compose up -d --build
```

### Backups

Data lives in two Docker volumes: `bee_pgdata` (PostgreSQL) and `bee_uploads`
(uploaded files). Keep a copy of `.env` too: without the same `SESSION_SECRET`
(or `AI_KEYS_SECRET`) users' saved AI keys cannot be decrypted.

```bash
docker compose exec postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > bee.dump
docker compose exec api tar -C /data/uploads -czf - . > uploads.tgz
```

`deploy/backup.sh` is the daily backup script of the reference deployment
(dump, uploads and `.env`, copied to a NAS) and can serve as a starting point.

### Configuration

All settings are environment variables in `.env`; see
[`.env.example`](.env.example) for the full list with comments.

| Variable | Default | Notes |
| --- | --- | --- |
| `BEE_PUBLIC_URL` | `http://localhost:7070` | Public origin, no trailing slash |
| `SESSION_SECRET`, `COLLAB_SECRET` | required | Long random strings |
| `POSTGRES_PASSWORD` | `bee` | Postgres is only reachable inside Docker and on `127.0.0.1:54329`; change it anyway |
| `ALLOWED_ORIGINS` | `http://localhost:7070` | Extra origins allowed to make cookie-authenticated requests |
| `ALLOW_REGISTRATION` | `true` | Set `false` to close sign-ups |
| `MAX_UPLOAD_MB` | `25` | Per-file upload limit |
| `AUTH_RATE_LIMIT`, `AI_RATE_LIMIT` | `20` | Sign-in attempts per IP / Ask AI requests per user, per minute |
| `GUEST_COMMENT_RATE_LIMIT` | `5` | Guest (no sign-in) comments per IP per minute |
| `GUEST_COMMENT_HOURLY_LIMIT` | `60` | Guest comments per share link per hour |
| `SMTP_URL`, `MAIL_FROM` | off | Email notifications, e.g. `smtps://user:pass@smtp.example.com:465` |
| `BUG_REPORT_TO` | off | Email address that receives "Report a problem" submissions (needs `SMTP_URL`) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | off | Browser push notifications (`npx web-push generate-vapid-keys`) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | off | "Continue with Google"; redirect URI `<BEE_PUBLIC_URL>/api/auth/google/callback` |
| `BEE_PORT` | `7070` | Host port of the proxy |

Ask AI needs no server configuration: each user connects their own AI account
(OpenRouter sign-in or an API key) in Settings.

## Claude and other MCP clients

Bee is a remote MCP server at `<BEE_PUBLIC_URL>/mcp` (Streamable HTTP). Claude can list
folders and documents, search, read documents as Markdown, create and edit them, rename and
move them, draw diagrams on whiteboards (new, existing, or embedded in a document) and
describe them, and read, add, reply to and resolve comments, always with the signed-in user's
permissions. Edits go through the collab server as ordinary Yjs changes, so people who have
the document open see them live; only the top-level blocks whose Markdown changed are
replaced, so other paragraphs keep their comments and block links.

- **Claude (claude.ai / desktop / mobile):** Settings → Connectors → Add custom connector,
  URL `<BEE_PUBLIC_URL>/mcp`. Claude registers itself (OAuth dynamic client
  registration) and opens Bee's sign-in and consent page once. Connected apps can be revoked
  in Bee under Settings.
- **Claude Code / scripts:** create a personal API token in Bee under Settings, then
  `claude mcp add --transport http bee <BEE_PUBLIC_URL>/mcp --header "Authorization: Bearer <token>"`.
  The same token works for the REST API (`Authorization: Bearer`).

## Development

Requires Node.js 22+ and Docker (for PostgreSQL).

```bash
corepack enable
pnpm install
cp .env.example .env
docker compose up -d postgres
pnpm db:migrate
pnpm dev
```

`pnpm test` runs the test suites (the API tests use a `bee_test` database on the
dev Postgres), `pnpm typecheck` and `pnpm lint` the checks. See
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

### Layout

| Path | What |
| --- | --- |
| `apps/api` | Fastify HTTP API: auth, workspaces, folders, docs, sharing, comments, versions, MCP server |
| `apps/collab` | Hocuspocus (Yjs) collaboration server, authorizes via `apps/api` |
| `apps/web` | Web client |
| `packages/db` | Drizzle schema + SQL migrations (PostgreSQL) |
| `packages/shared` | Shared types, roles and permission logic |
| `packages/editor` | Tiptap editor extensions shared by web and collab |
| `deploy` | Scripts of the reference deployment (see below) |

Public port **7070** (Caddy, config inline in `docker-compose.yml`) routes `/api/*`, `/mcp`,
`/oauth/*` and `/.well-known/oauth-*` to api:8421, `/collab*` to collab:1234, and everything
else to web:8423. Dev Postgres listens on `localhost:54329`.

### Reference deployment

bee.zippyzoo.dev runs this same `docker-compose.yml` on a Mac mini behind a
Cloudflare Tunnel. `deploy/sync.sh` deploys committed `main` there over SSH: it
runs typecheck and tests locally, ships `git archive HEAD`, creates `.env` with
fresh secrets on first deploy, rebuilds the stack and waits for
`/api/health`. To use it for your own server, copy `deploy/deploy.env.example`
to `deploy/deploy.env` (not committed) and fill in your SSH host and public URL.

## License

Bee is free software under the [GNU Affero General Public License v3.0](LICENSE)
(AGPL-3.0-only). If you run a modified version for others over a network, the
AGPL requires you to offer them the source of your version.

**Commercial licenses** are available for organizations that want to use,
modify or embed Bee without the AGPL's obligations. Contact
[contactus@bee.zippyzoo.dev](mailto:contactus@bee.zippyzoo.dev).

Contributions are accepted under the [Contributor License Agreement](CLA.md),
which is what makes dual licensing possible; see [CONTRIBUTING.md](CONTRIBUTING.md).
