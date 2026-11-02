import type { FastifyInstance, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { documents, users } from '@bee/db';
import { isReadOnly, type CollabAuthResponse } from '@bee/shared';
import { docAccess } from '../lib/access.js';
import { logEdit } from '../lib/activity.js';
import { sessionTokenFromCookieHeader, userForSession } from '../lib/auth.js';
import { deriveCaches } from '../lib/content.js';
import { badRequest, HttpError, notFound } from '../lib/errors.js';
import { idParams, parse } from '../lib/validate.js';
import { insertVersion } from './versions.js';

const authBody = z.object({
  documentId: z.uuid(),
  cookie: z.string().max(8192).optional(),
  shareToken: z.string().max(100).optional(),
});

/**
 * Endpoints for the collab server only (docker-internal; Caddy does not need to
 * block them because every call is checked against COLLAB_SECRET).
 */
export async function internalRoutes(app: FastifyInstance) {
  const { db, config } = app;
  const secret = Buffer.from(config.collabSecret);

  app.addHook('onRequest', async (req: FastifyRequest) => {
    if (!req.url.startsWith('/api/internal/')) return;
    const got = Buffer.from(String(req.headers['x-collab-secret'] ?? ''));
    if (got.length !== secret.length || !timingSafeEqual(got, secret)) {
      throw new HttpError(401, 'bad_secret', 'Invalid collab secret');
    }
  });

  /** Validated author ids from the x-author-ids header. */
  const authorIds = async (req: FastifyRequest): Promise<string[]> => {
    const raw = String(req.headers['x-author-ids'] ?? '');
    const ids = [...new Set(raw.split(',').map((s) => s.trim()))].filter(
      (s) => z.uuid().safeParse(s).success,
    );
    if (!ids.length) return [];
    const rows = await db.select({ id: users.id }).from(users).where(inArray(users.id, ids));
    const ok = new Set(rows.map((r) => r.id));
    return ids.filter((id) => ok.has(id));
  };

  const bodyBuffer = (req: FastifyRequest): Buffer => {
    if (!Buffer.isBuffer(req.body)) throw badRequest('Expected application/octet-stream body');
    return req.body;
  };

  app.post('/internal/collab/auth', async (req): Promise<CollabAuthResponse> => {
    const body = parse(authBody, req.body);
    const session = await userForSession(db, sessionTokenFromCookieHeader(body.cookie));
    const user = session?.user ?? null;
    // docAccess throws 404 (missing or not readable by a signed-in user) or 401 (anonymous).
    const a = await docAccess(db, {
      userId: user?.id ?? null,
      documentId: body.documentId,
      shareToken: body.shareToken,
    });
    if (!user && !a.role) throw new HttpError(401, 'unauthorized', 'Sign in required');
    return {
      user: user ? { id: user.id, name: user.name, color: user.color } : null,
      role: a.role,
      readOnly: isReadOnly(a.role),
      documentType: a.doc.type,
    };
  });

  app.get('/internal/collab/documents/:id/state', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const [d] = await db
      .select({ s: documents.ydocState })
      .from(documents)
      .where(eq(documents.id, id));
    if (!d) throw notFound('Document not found');
    if (!d.s || !d.s.length) return reply.status(204).send();
    return reply.header('content-type', 'application/octet-stream').send(d.s);
  });

  app.put('/internal/collab/documents/:id/state', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const state = bodyBuffer(req);
    const [d] = await db
      .select({ id: documents.id, type: documents.type, workspaceId: documents.workspaceId })
      .from(documents)
      .where(eq(documents.id, id));
    if (!d) throw notFound('Document not found');
    const authors = await authorIds(req);
    let caches: ReturnType<typeof deriveCaches> | null = null;
    if (d.type === 'doc') {
      try {
        caches = deriveCaches(state);
      } catch (err) {
        req.log.warn({ err, id }, 'could not derive caches from state');
      }
    }
    const now = new Date();
    await db
      .update(documents)
      .set({
        ydocState: state,
        contentUpdatedAt: now,
        updatedAt: now,
        ...(authors[0] ? { lastEditedById: authors[0] } : {}),
        ...(caches
          ? { markdownCache: caches.markdown, textCache: caches.text, blockIds: caches.blockIds }
          : {}),
      })
      .where(eq(documents.id, id));
    for (const a of authors) await logEdit(db, d.workspaceId, id, a);
    return reply.status(204).send();
  });

  /** Optional: markdown rendered by the collab server (overrides the derived cache). */
  app.put('/internal/collab/documents/:id/markdown', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const md = bodyBuffer(req).toString('utf8');
    const res = await db
      .update(documents)
      .set({ markdownCache: md })
      .where(eq(documents.id, id))
      .returning({ id: documents.id });
    if (!res.length) throw notFound('Document not found');
    return reply.status(204).send();
  });

  app.post('/internal/collab/documents/:id/versions', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const snapshot = bodyBuffer(req);
    const [d] = await db.select({ id: documents.id }).from(documents).where(eq(documents.id, id));
    if (!d) throw notFound('Document not found');
    const authors = await authorIds(req);
    const v = await insertVersion(db, {
      documentId: id,
      snapshot,
      kind: 'auto',
      authorIds: authors,
      createdById: authors[0] ?? null,
    });
    return reply.status(v ? 201 : 200).send({ id: v?.id ?? null });
  });
}
