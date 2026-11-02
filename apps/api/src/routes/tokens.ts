import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { apiTokens } from '@bee/db';
import type { ApiTokenDTO, ConnectedAppDTO } from '@bee/shared';
import { forbidden, notFound } from '../lib/errors.js';
import { issueToken, type TokenRow } from '../lib/tokens.js';
import { parse } from '../lib/validate.js';
import { requireUser } from './auth.js';

const tokenDTO = (t: TokenRow): ApiTokenDTO => ({
  id: t.id,
  name: t.name,
  prefix: t.prefix,
  createdAt: t.createdAt.toISOString(),
  lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
});

/** Token management needs a browser session: a token cannot mint or list other tokens. */
function requireSessionUser(req: FastifyRequest) {
  const user = requireUser(req);
  if (req.authKind !== 'session') throw forbidden('Manage tokens from the Bee web app');
  return user;
}

export async function tokenRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get('/tokens', async (req) => {
    const user = requireSessionUser(req);
    const rows = await db
      .select()
      .from(apiTokens)
      .where(and(eq(apiTokens.userId, user.id), eq(apiTokens.kind, 'personal')))
      .orderBy(desc(apiTokens.createdAt));
    return { tokens: rows.map(tokenDTO) };
  });

  app.post('/tokens', async (req, reply) => {
    const user = requireSessionUser(req);
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(100) }), req.body);
    const { token, row } = await issueToken(db, { userId: user.id, kind: 'personal', name });
    return reply.status(201).send({ token: tokenDTO(row), secret: token });
  });

  app.delete('/tokens/:id', async (req) => {
    const user = requireSessionUser(req);
    const { id } = parse(z.object({ id: z.string().regex(/^[0-9a-f]{64}$/) }), req.params);
    const res = await db
      .delete(apiTokens)
      .where(
        and(eq(apiTokens.id, id), eq(apiTokens.userId, user.id), eq(apiTokens.kind, 'personal')),
      )
      .returning({ id: apiTokens.id });
    if (!res.length) throw notFound('Token not found');
    return { ok: true };
  });

  /** OAuth authorizations (e.g. a Claude connector), one entry per grant. */
  app.get('/connected-apps', async (req) => {
    const user = requireSessionUser(req);
    const rows = await db
      .select()
      .from(apiTokens)
      .where(
        and(
          eq(apiTokens.userId, user.id),
          inArray(apiTokens.kind, ['oauth_access', 'oauth_refresh']),
        ),
      )
      .orderBy(apiTokens.createdAt);
    const byGrant = new Map<string, ConnectedAppDTO>();
    for (const r of rows) {
      if (!r.grantId) continue;
      const cur = byGrant.get(r.grantId);
      const used = r.lastUsedAt?.toISOString() ?? null;
      if (!cur) {
        byGrant.set(r.grantId, {
          id: r.grantId,
          name: r.name,
          createdAt: r.createdAt.toISOString(),
          lastUsedAt: used,
        });
      } else if (used && (!cur.lastUsedAt || used > cur.lastUsedAt)) cur.lastUsedAt = used;
    }
    return { apps: [...byGrant.values()].reverse() };
  });

  app.delete('/connected-apps/:id', async (req) => {
    const user = requireSessionUser(req);
    const { id } = parse(z.object({ id: z.uuid() }), req.params);
    await db.delete(apiTokens).where(and(eq(apiTokens.userId, user.id), eq(apiTokens.grantId, id)));
    return { ok: true };
  });
}
