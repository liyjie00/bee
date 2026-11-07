import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { SESSION_COOKIE } from '@bee/shared';
import type { Db } from '@bee/db';
import type { Config } from './env.js';
import { userForSession, type UserRow } from './lib/auth.js';
import { HttpError } from './lib/errors.js';
import { authRoutes, setSessionCookie } from './routes/auth.js';
import { googleAuthRoutes } from './routes/google-auth.js';
import { workspaceRoutes } from './routes/workspaces.js';
import { teamRoutes } from './routes/teams.js';
import { folderRoutes } from './routes/folders.js';
import { documentRoutes } from './routes/documents.js';
import { versionRoutes } from './routes/versions.js';
import { commentRoutes } from './routes/comments.js';
import { sharingRoutes } from './routes/sharing.js';
import { avatarRoutes } from './routes/avatars.js';
import { uploadRoutes } from './routes/uploads.js';
import { internalRoutes } from './routes/internal.js';
import { tokenRoutes } from './routes/tokens.js';
import { oauthRoutes } from './routes/oauth.js';
import { mcpRoutes } from './routes/mcp.js';
import { aiRoutes } from './routes/ai.js';
import { notificationRoutes } from './routes/notifications.js';
import { bugReportRoutes } from './routes/bug-reports.js';
import { setupDelivery } from './lib/delivery.js';
import { bearerFrom, userForBearer } from './lib/tokens.js';
import { clientIp } from './lib/ip.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    config: Config;
  }
  interface FastifyRequest {
    user: UserRow | null;
    /** how `user` was authenticated */
    authKind: 'session' | 'token' | null;
    /** share token from x-share-token header or ?share= */
    shareToken: string | null;
  }
}

export async function buildApp(opts: {
  db: Db;
  config: Config;
  logger?: boolean;
}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: true,
    bodyLimit: 10 * 1024 * 1024,
    // Signed upload links carry their ticket in the path.
    routerOptions: { maxParamLength: 1000 },
  });
  app.decorate('db', opts.db);
  app.decorate('config', opts.config);
  app.decorateRequest('user', null);
  app.decorateRequest('authKind', null);
  app.decorateRequest('shareToken', null);

  await app.register(cookie, { secret: opts.config.sessionSecret });
  await app.register(multipart, { limits: { fileSize: opts.config.maxUploadBytes, files: 1 } });
  await app.register(rateLimit, { global: false, keyGenerator: clientIp });

  app.addContentTypeParser(
    ['application/octet-stream', 'text/markdown', 'text/plain'],
    { parseAs: 'buffer', bodyLimit: 50 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );
  // OAuth token / consent forms.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string', bodyLimit: 64 * 1024 },
    (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
  );

  // MCP and OAuth endpoints use bearer tokens or no credentials at all, so any origin
  // may call them (browser-based MCP clients).
  const isTokenEndpoint = (url: string) =>
    url.startsWith('/mcp') ||
    url.startsWith('/.well-known/') ||
    url.startsWith('/oauth/token') ||
    url.startsWith('/oauth/register') ||
    url.startsWith('/oauth/revoke');
  app.addHook('onRequest', async (req, reply) => {
    if (!isTokenEndpoint(req.url)) return;
    reply.header('access-control-allow-origin', '*');
    reply.header('access-control-expose-headers', 'www-authenticate, mcp-session-id');
    if (req.method === 'OPTIONS') {
      reply
        .header('access-control-allow-methods', 'GET, POST, DELETE, OPTIONS')
        .header(
          'access-control-allow-headers',
          'authorization, content-type, mcp-protocol-version, mcp-session-id',
        )
        .header('access-control-max-age', '86400')
        .status(204)
        .send();
    }
  });

  // CSRF: browsers always send Origin on cross-site mutating requests.
  const allowedOrigins = new Set([
    new URL(opts.config.publicUrl).origin,
    ...opts.config.allowedOrigins,
  ]);
  app.addHook('onRequest', async (req) => {
    if (
      ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ||
      req.url.startsWith('/api/internal/') ||
      isTokenEndpoint(req.url) ||
      // Browsers cannot attach a bearer token cross-site without a CORS preflight.
      bearerFrom(req.headers.authorization)
    )
      return;
    const origin = req.headers.origin;
    if (origin && !allowedOrigins.has(origin) && process.env.NODE_ENV === 'production') {
      throw new HttpError(403, 'bad_origin', 'Cross-origin request rejected');
    }
  });

  app.addHook('preHandler', async (req, reply) => {
    const header = req.headers['x-share-token'];
    const q = (req.query as Record<string, unknown> | undefined)?.share;
    req.shareToken = (typeof header === 'string' && header) || (typeof q === 'string' && q) || null;
    if (req.url.startsWith('/api/internal/')) return;
    const bearer = bearerFrom(req.headers.authorization);
    if (bearer) {
      // An invalid bearer token never falls back to the cookie.
      const hit = await userForBearer(app.db, bearer);
      // /mcp answers with its own 401 that points clients at the OAuth metadata.
      if (!hit && req.url.startsWith('/mcp')) return;
      if (!hit) {
        reply.header('www-authenticate', 'Bearer error="invalid_token"');
        throw new HttpError(401, 'invalid_token', 'Invalid or expired token');
      }
      req.user = hit.user;
      req.authKind = 'token';
      return;
    }
    if (req.url.startsWith('/mcp')) return;
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const s = await userForSession(app.db, token);
    if (!s) {
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return;
    }
    req.user = s.user;
    req.authKind = 'session';
    if (s.refreshedExpiry) setSessionCookie(reply, app.config, token, s.refreshedExpiry);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode === 429) {
      return reply.status(429).send({
        error: { code: 'rate_limited', message: 'Too many attempts, try again in a minute' },
      });
    }
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({
        error: {
          code: (e.code ?? 'bad_request').toLowerCase(),
          message: e.message ?? 'Bad request',
        },
      });
    }
    req.log.error(err);
    return reply
      .status(500)
      .send({ error: { code: 'internal', message: 'Internal server error' } });
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send({ error: { code: 'not_found', message: 'Not found' } }),
  );

  setupDelivery(app, opts.db, opts.config);
  app.get('/api/health', async () => ({ ok: true }));
  await app.register(oauthRoutes);
  await app.register(mcpRoutes);

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(googleAuthRoutes);
      await api.register(workspaceRoutes);
      await api.register(teamRoutes);
      await api.register(folderRoutes);
      await api.register(documentRoutes);
      await api.register(versionRoutes);
      await api.register(commentRoutes);
      await api.register(sharingRoutes);
      await api.register(uploadRoutes);
      await api.register(avatarRoutes);
      await api.register(internalRoutes);
      await api.register(tokenRoutes);
      await api.register(aiRoutes);
      await api.register(notificationRoutes);
      await api.register(bugReportRoutes);
    },
    { prefix: '/api' },
  );
  return app;
}
