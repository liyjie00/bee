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
import { workspaceRoutes } from './routes/workspaces.js';
import { folderRoutes } from './routes/folders.js';
import { documentRoutes } from './routes/documents.js';
import { versionRoutes } from './routes/versions.js';
import { commentRoutes } from './routes/comments.js';
import { sharingRoutes } from './routes/sharing.js';
import { uploadRoutes } from './routes/uploads.js';
import { internalRoutes } from './routes/internal.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    config: Config;
  }
  interface FastifyRequest {
    user: UserRow | null;
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
  });
  app.decorate('db', opts.db);
  app.decorate('config', opts.config);
  app.decorateRequest('user', null);
  app.decorateRequest('shareToken', null);

  await app.register(cookie, { secret: opts.config.sessionSecret });
  await app.register(multipart, { limits: { fileSize: opts.config.maxUploadBytes, files: 1 } });
  await app.register(rateLimit, { global: false });

  app.addContentTypeParser(
    ['application/octet-stream', 'text/markdown', 'text/plain'],
    { parseAs: 'buffer', bodyLimit: 50 * 1024 * 1024 },
    (_req, body, done) => done(null, body),
  );

  // CSRF: browsers always send Origin on cross-site mutating requests.
  const allowedOrigins = new Set([
    new URL(opts.config.publicUrl).origin,
    ...opts.config.allowedOrigins,
  ]);
  app.addHook('onRequest', async (req) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.url.startsWith('/api/internal/'))
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
    const token = req.cookies[SESSION_COOKIE];
    if (!token) return;
    const s = await userForSession(app.db, token);
    if (!s) {
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return;
    }
    req.user = s.user;
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

  app.get('/api/health', async () => ({ ok: true }));

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(workspaceRoutes);
      await api.register(folderRoutes);
      await api.register(documentRoutes);
      await api.register(versionRoutes);
      await api.register(commentRoutes);
      await api.register(sharingRoutes);
      await api.register(uploadRoutes);
      await api.register(internalRoutes);
    },
    { prefix: '/api' },
  );
  return app;
}
