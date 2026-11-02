# Bee

[English](README.md) | 简体中文

开源、可自托管的协作文档（类似 Quip）：实时协同编辑、Markdown、版本历史、行内评论、
文件夹树、白板，以及私有 / 成员 / 公开链接分享。Bee 同时是一个远程 MCP 服务器，
Claude 等 MCP 客户端可以读取和编辑你的文档。

官方托管实例：[bee.zippyzoo.dev](https://bee.zippyzoo.dev)。

## 自托管

需要 Docker 和 Compose v2（Docker Desktop、OrbStack，或 Linux 上的 Docker Engine）。
整套服务（PostgreSQL、API、协同服务器、Web 客户端和 Caddy 反向代理）都由
`docker-compose.yml` 启动，对外只暴露代理端口。

```bash
git clone <本仓库地址> bee && cd bee
cp .env.example .env
# 把 SESSION_SECRET 和 COLLAB_SECRET 设为足够长的随机字符串，例如：
#   openssl rand -hex 32
# 把 BEE_PUBLIC_URL 设为用户访问的地址，例如 https://docs.example.com
docker compose up -d --build
```

然后打开 `BEE_PUBLIC_URL`（默认 <http://localhost:7070>）注册第一个账号。
API 启动时会自动执行数据库迁移。

### 发布到公网

代理在 `BEE_PORT`（默认 7070）上提供纯 HTTP。请用你现有的方式在前面加 TLS：
反向代理（Caddy、nginx、Traefik）、负载均衡，或 Cloudflare Tunnel 之类的隧道，
把你的域名指向 `http://localhost:7070`。代理必须放行 `/collab` 的 WebSocket 升级。

把 `BEE_PUBLIC_URL` 设为公网的 `https://` 地址。分享链接、安全 Cookie、CSRF 来源检查
以及 MCP 服务器的 OAuth issuer 都依赖它，必须与浏览器看到的地址一致。
自己的账号建好后，可以设置 `ALLOW_REGISTRATION=false` 关闭注册。

### 更新

```bash
git pull
docker compose up -d --build
```

### 备份

数据存放在两个 Docker 卷中：`bee_pgdata`（PostgreSQL）和 `bee_uploads`（上传的文件）。
也请备份 `.env`：没有相同的 `SESSION_SECRET`（或 `AI_KEYS_SECRET`），
用户保存的 AI 密钥将无法解密。

```bash
docker compose exec postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > bee.dump
docker compose exec api tar -C /data/uploads -czf - . > uploads.tgz
```

`deploy/backup.sh` 是参考部署使用的每日备份脚本（数据库、上传文件和 `.env`，
并复制到 NAS），可以作为起点。

### 配置

所有设置都是 `.env` 中的环境变量，完整列表和说明见 [`.env.example`](.env.example)。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BEE_PUBLIC_URL` | `http://localhost:7070` | 公网地址，末尾不带斜杠 |
| `SESSION_SECRET`、`COLLAB_SECRET` | 必填 | 足够长的随机字符串 |
| `POSTGRES_PASSWORD` | `bee` | Postgres 只在 Docker 内部和 `127.0.0.1:54329` 可访问，但仍建议修改 |
| `ALLOWED_ORIGINS` | `http://localhost:7070` | 额外允许发起带 Cookie 请求的来源 |
| `ALLOW_REGISTRATION` | `true` | 设为 `false` 关闭注册 |
| `MAX_UPLOAD_MB` | `25` | 单个文件上传上限 |
| `AUTH_RATE_LIMIT`、`AI_RATE_LIMIT` | `20` | 每分钟：每个 IP 的登录尝试次数 / 每个用户的 Ask AI 请求数 |
| `GUEST_COMMENT_RATE_LIMIT` | `5` | 每个 IP 每分钟的访客（未登录）评论数 |
| `GUEST_COMMENT_HOURLY_LIMIT` | `60` | 每个分享链接每小时的访客评论数 |
| `SMTP_URL`、`MAIL_FROM` | 关闭 | 邮件通知，例如 `smtps://user:pass@smtp.example.com:465` |
| `VAPID_PUBLIC_KEY`、`VAPID_PRIVATE_KEY` | 关闭 | 浏览器推送通知（`npx web-push generate-vapid-keys`） |
| `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` | 关闭 | “使用 Google 登录”，回调地址 `<BEE_PUBLIC_URL>/api/auth/google/callback` |
| `BEE_PORT` | `7070` | 代理在宿主机上的端口 |

Ask AI 不需要服务器端配置：每个用户在设置里连接自己的 AI 账号（OpenRouter 登录或 API 密钥）。

## Claude 与其他 MCP 客户端

Bee 在 `<BEE_PUBLIC_URL>/mcp` 提供远程 MCP 服务（Streamable HTTP）。Claude 可以列出文件夹和文档、
搜索、以 Markdown 读取文档、创建和编辑文档、重命名和移动、在白板上画图（新建、已有，或嵌入文档中）
并描述白板，以及读取、添加、回复和解决评论，权限始终与登录用户一致。编辑通过协同服务器以普通的
Yjs 变更写入，打开文档的人会实时看到；只有 Markdown 发生变化的顶层块会被替换，其他段落的评论和
块链接都会保留。

- **Claude（claude.ai / 桌面端 / 移动端）：** 设置 → 连接器 → 添加自定义连接器，
  URL 填 `<BEE_PUBLIC_URL>/mcp`。Claude 会自动注册（OAuth 动态客户端注册），并打开一次 Bee 的
  登录和授权页面。已连接的应用可以在 Bee 的设置中撤销。
- **Claude Code / 脚本：** 在 Bee 设置里创建个人 API 令牌，然后运行
  `claude mcp add --transport http bee <BEE_PUBLIC_URL>/mcp --header "Authorization: Bearer <token>"`。
  同一个令牌也可用于 REST API（`Authorization: Bearer`）。

## 开发

需要 Node.js 22+ 和 Docker（用于 PostgreSQL）。

```bash
corepack enable
pnpm install
cp .env.example .env
docker compose up -d postgres
pnpm db:migrate
pnpm dev
```

`pnpm test` 运行测试（API 测试使用开发 Postgres 上的 `bee_test` 数据库），
`pnpm typecheck` 和 `pnpm lint` 运行检查。提交 Pull Request 前请先阅读
[CONTRIBUTING.md](CONTRIBUTING.md)。

### 目录结构

| 路径 | 内容 |
| --- | --- |
| `apps/api` | Fastify HTTP API：认证、工作区、文件夹、文档、分享、评论、版本、MCP 服务器 |
| `apps/collab` | Hocuspocus（Yjs）协同服务器，通过 `apps/api` 鉴权 |
| `apps/web` | Web 客户端 |
| `packages/db` | Drizzle schema 和 SQL 迁移（PostgreSQL） |
| `packages/shared` | 共享类型、角色和权限逻辑 |
| `packages/editor` | Web 端和协同服务器共用的 Tiptap 编辑器扩展 |
| `deploy` | 参考部署的脚本（见下文） |

公网端口 **7070**（Caddy，配置内联在 `docker-compose.yml` 中）把 `/api/*`、`/mcp`、`/oauth/*`
和 `/.well-known/oauth-*` 转发到 api:8421，`/collab*` 转发到 collab:1234，其余转发到 web:8423。
开发用 Postgres 监听 `localhost:54329`。

### 参考部署

bee.zippyzoo.dev 在一台 Mac mini 上运行同一份 `docker-compose.yml`，前面是 Cloudflare Tunnel。
`deploy/sync.sh` 通过 SSH 把已提交的 `main` 部署过去：先在本地跑类型检查和测试，传输
`git archive HEAD`，首次部署时生成带新密钥的 `.env`，重新构建并等待 `/api/health` 正常。
要部署到你自己的服务器，把 `deploy/deploy.env.example` 复制为 `deploy/deploy.env`（不会提交），
填上你的 SSH 主机名和公网地址。

## 许可证

Bee 是自由软件，采用 [GNU Affero 通用公共许可证 v3.0](LICENSE)（AGPL-3.0-only）。
如果你修改了 Bee 并通过网络向他人提供服务，AGPL 要求你向这些用户提供修改后版本的源代码。

**商业许可：** 如果你的组织希望在不承担 AGPL 义务的情况下使用、修改或嵌入 Bee，
可以获得商业许可，请联系 [contactus@bee.zippyzoo.dev](mailto:contactus@bee.zippyzoo.dev)。

贡献需遵守[贡献者许可协议](CLA.md)（CLA），这是双重许可得以实现的前提；详见
[CONTRIBUTING.md](CONTRIBUTING.md)。
