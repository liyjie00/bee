import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, count, eq, gt, inArray, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { commentThreads, comments, type Db } from '@bee/db';
import {
  can,
  GUEST_COMMENT_MAX,
  GUEST_NAME_MAX,
  guestColor,
  type CommentDTO,
  type CommentThreadDTO,
  type UserRef,
} from '@bee/shared';
import { docAccess, guestsMayComment, validShareLink, type DocAccess } from '../lib/access.js';
import { logActivity } from '../lib/activity.js';
import { badRequest, forbidden, HttpError, notFound, unauthorized } from '../lib/errors.js';
import { loadUserRefs, refOr } from '../lib/dto.js';
import { clientIp } from '../lib/ip.js';
import { idParams, parse } from '../lib/validate.js';
import { requireUser } from './auth.js';

type ThreadRow = typeof commentThreads.$inferSelect;
type CommentRow = typeof comments.$inferSelect;

const anchor = z
  .object({
    blockId: z.string().min(1).max(64),
    from: z.unknown(),
    to: z.unknown(),
    quote: z.string().max(2000),
  })
  .nullable();
const body = z.string().trim().min(1).max(20_000);
const guestName = z.string().trim().min(1).max(GUEST_NAME_MAX).optional();

/** Header guests send with a random per-browser key, so they can delete their own comments. */
const GUEST_KEY_HEADER = 'x-guest-key';

function guestKeyHash(req: FastifyRequest): string | null {
  const k = req.headers[GUEST_KEY_HEADER];
  if (typeof k !== 'string' || k.length < 16 || k.length > 128) return null;
  return createHash('sha256').update(k).digest('hex');
}

/** Who is reading comments: decides `canDelete` on each one. */
interface Viewer {
  userId: string | null;
  guestKeyHash: string | null;
  canManage: boolean;
}

const viewerOf = (req: FastifyRequest, a: DocAccess): Viewer => ({
  userId: req.user?.id ?? null,
  guestKeyHash: req.user ? null : guestKeyHash(req),
  canManage: can.manage(a.role),
});

async function threadDTOs(
  db: Db,
  threads: ThreadRow[],
  all: CommentRow[],
  viewer: Viewer,
): Promise<CommentThreadDTO[]> {
  const refs = await loadUserRefs(db, [
    ...threads.flatMap((t) => [t.createdById, t.resolvedById]),
    ...all.map((c) => c.authorId),
  ]);
  const byThread = new Map<string, CommentRow[]>();
  for (const c of all) byThread.set(c.threadId, [...(byThread.get(c.threadId) ?? []), c]);
  return threads.map((t) => {
    const list = byThread.get(t.id) ?? [];
    return {
      id: t.id,
      documentId: t.documentId,
      anchor: t.anchor ?? null,
      resolved: !!t.resolvedAt,
      resolvedBy: t.resolvedById ? refOr(refs, t.resolvedById) : null,
      resolvedAt: t.resolvedAt?.toISOString() ?? null,
      createdAt: t.createdAt.toISOString(),
      comments: list.map((c, i) =>
        commentDTO(c, refs, i === 0 ? (t.anchor ?? null) : null, viewer),
      ),
    };
  });
}

function commentDTO(
  c: CommentRow,
  refs: Map<string, UserRef>,
  a: CommentDTO['anchor'],
  viewer: Viewer,
): CommentDTO {
  const guest = !c.authorId;
  const name = c.guestName ?? 'Guest';
  const own = guest
    ? !!viewer.guestKeyHash && c.guestKeyHash === viewer.guestKeyHash
    : c.authorId === viewer.userId;
  return {
    id: c.id,
    documentId: c.documentId,
    threadId: c.threadId,
    anchor: a,
    body: c.body,
    author: guest
      ? { id: '', name, avatarUrl: null, color: guestColor(name) }
      : refOr(refs, c.authorId),
    guest,
    canDelete: own || viewer.canManage,
    createdAt: c.createdAt.toISOString(),
    editedAt: c.editedAt?.toISOString() ?? null,
  };
}

export async function commentRoutes(app: FastifyInstance) {
  const { db, config } = app;

  /**
   * Posting is rate limited per signed-in user, and much tighter per IP for guests;
   * guests are also capped per share link per hour (see `authorFor`).
   */
  const limited = {
    config: {
      rateLimit: {
        // after the app's preHandler has resolved req.user
        hook: 'preHandler' as const,
        max: (req: FastifyRequest) => (req.user ? 120 : config.guestCommentRateLimit),
        timeWindow: '1 minute',
        keyGenerator: (req: FastifyRequest) =>
          req.user ? `u:${req.user.id}` : `ip:${clientIp(req)}`,
      },
    },
  };

  /**
   * Checks the caller may comment and returns the author columns for a new comment:
   * the signed-in user, or a guest (nickname + browser key) on a public link that
   * allows guest comments.
   */
  const authorFor = async (
    req: FastifyRequest,
    documentId: string,
    text: string,
    name: string | undefined,
  ) => {
    const userId = req.user?.id ?? null;
    const a = await docAccess(db, { userId, documentId, shareToken: req.shareToken });
    if (!can.comment(a.role)) {
      if (!userId) throw unauthorized('Sign in to comment');
      throw forbidden('You cannot comment on this document');
    }
    if (userId) return { a, cols: { authorId: userId }, actorId: userId, label: '' };
    // Anonymous: only a public link with guest comments gets them this far.
    const link = await validShareLink(db, req.shareToken);
    if (!guestsMayComment(link)) throw unauthorized('Sign in to comment');
    if (!name) throw badRequest('Enter a name to comment', 'guest_name_required');
    const keyHash = guestKeyHash(req);
    if (!keyHash) throw badRequest('Missing guest key', 'guest_key_required');
    if (text.length > GUEST_COMMENT_MAX)
      throw badRequest(`Comments are limited to ${GUEST_COMMENT_MAX} characters`);
    const [recent] = await db
      .select({ n: count() })
      .from(comments)
      .where(
        and(
          eq(comments.shareLinkId, link!.id),
          gt(comments.createdAt, new Date(Date.now() - 60 * 60 * 1000)),
        ),
      );
    if ((recent?.n ?? 0) >= config.guestCommentHourlyLimit)
      throw new HttpError(429, 'rate_limited', 'Too many guest comments on this link, try later');
    return {
      a,
      cols: { authorId: null, guestName: name, guestKeyHash: keyHash, shareLinkId: link!.id },
      actorId: null,
      label: `${name}: `,
    };
  };

  const loadThread = async (tid: string) => {
    const [t] = await db.select().from(commentThreads).where(eq(commentThreads.id, tid));
    if (!t) throw notFound('Thread not found');
    return t;
  };
  const threadWithComments = async (t: ThreadRow, viewer: Viewer) => {
    const list = await db
      .select()
      .from(comments)
      .where(eq(comments.threadId, t.id))
      .orderBy(asc(comments.createdAt));
    return (await threadDTOs(db, [t], list, viewer))[0]!;
  };

  app.get('/documents/:id/threads', async (req) => {
    const { id } = parse(idParams, req.params);
    const { resolved } = parse(z.object({ resolved: z.enum(['0', '1']).optional() }), req.query);
    const a = await docAccess(db, {
      userId: req.user?.id ?? null,
      documentId: id,
      shareToken: req.shareToken,
    });
    const cond = [eq(commentThreads.documentId, id)];
    if (resolved === '0') cond.push(isNull(commentThreads.resolvedAt));
    if (resolved === '1') cond.push(isNotNull(commentThreads.resolvedAt));
    const threads = await db
      .select()
      .from(commentThreads)
      .where(and(...cond))
      .orderBy(asc(commentThreads.createdAt));
    const list = threads.length
      ? await db
          .select()
          .from(comments)
          .where(
            inArray(
              comments.threadId,
              threads.map((t) => t.id),
            ),
          )
          .orderBy(asc(comments.createdAt))
      : [];
    return { threads: await threadDTOs(db, threads, list, viewerOf(req, a)) };
  });

  app.post('/documents/:id/threads', limited, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ anchor, body, guestName }), req.body);
    const { a, cols, actorId, label } = await authorFor(req, id, b.body, b.guestName);
    const t = await db.transaction(async (tx) => {
      const [t] = await tx
        .insert(commentThreads)
        .values({ documentId: id, anchor: b.anchor ?? null, createdById: actorId })
        .returning();
      await tx.insert(comments).values({ threadId: t!.id, documentId: id, body: b.body, ...cols });
      return t!;
    });
    await logActivity(db, {
      workspaceId: a.doc.workspaceId,
      documentId: id,
      actorId,
      kind: 'commented',
      detail: (label + b.body).slice(0, 200),
    });
    return reply.status(201).send({ thread: await threadWithComments(t, viewerOf(req, a)) });
  });

  app.post('/threads/:id/comments', limited, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ body, guestName }), req.body);
    const t = await loadThread(id);
    const { a, cols, actorId, label } = await authorFor(req, t.documentId, b.body, b.guestName);
    const [c] = await db
      .insert(comments)
      .values({ threadId: id, documentId: t.documentId, body: b.body, ...cols })
      .returning();
    // Replying to a resolved thread reopens it.
    if (t.resolvedAt)
      await db
        .update(commentThreads)
        .set({ resolvedAt: null, resolvedById: null })
        .where(eq(commentThreads.id, id));
    await logActivity(db, {
      workspaceId: a.doc.workspaceId,
      documentId: t.documentId,
      actorId,
      kind: 'commented',
      detail: (label + b.body).slice(0, 200),
    });
    const refs = await loadUserRefs(db, [actorId]);
    return reply.status(201).send({ comment: commentDTO(c!, refs, null, viewerOf(req, a)) });
  });

  app.patch('/threads/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const { resolved } = parse(z.object({ resolved: z.boolean() }), req.body);
    const t = await loadThread(id);
    const a = await docAccess(db, {
      userId: user.id,
      documentId: t.documentId,
      shareToken: req.shareToken,
    });
    if (!can.comment(a.role)) throw forbidden();
    const [nt] = await db
      .update(commentThreads)
      .set(
        resolved
          ? { resolvedAt: new Date(), resolvedById: user.id }
          : { resolvedAt: null, resolvedById: null },
      )
      .where(eq(commentThreads.id, id))
      .returning();
    if (resolved)
      await logActivity(db, {
        workspaceId: a.doc.workspaceId,
        documentId: t.documentId,
        actorId: user.id,
        kind: 'resolved',
      });
    return { thread: await threadWithComments(nt!, viewerOf(req, a)) };
  });

  app.delete('/threads/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const t = await loadThread(id);
    const a = await docAccess(db, {
      userId: user.id,
      documentId: t.documentId,
      shareToken: req.shareToken,
    });
    if (t.createdById !== user.id && !can.manage(a.role)) throw forbidden();
    await db.delete(commentThreads).where(eq(commentThreads.id, id));
    return { ok: true };
  });

  const loadComment = async (cid: string) => {
    const [c] = await db.select().from(comments).where(eq(comments.id, cid));
    if (!c) throw notFound('Comment not found');
    return c;
  };

  app.patch('/comments/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ body }), req.body);
    const c = await loadComment(id);
    const a = await docAccess(db, {
      userId: user.id,
      documentId: c.documentId,
      shareToken: req.shareToken,
    });
    if (c.authorId !== user.id) throw forbidden('You can only edit your own comments');
    const [nc] = await db
      .update(comments)
      .set({ body: b.body, editedAt: new Date() })
      .where(eq(comments.id, id))
      .returning();
    const refs = await loadUserRefs(db, [user.id]);
    return { comment: commentDTO(nc!, refs, null, viewerOf(req, a)) };
  });

  /** Authors (signed-in, or guests by their browser key) and document owners may delete. */
  app.delete('/comments/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const c = await loadComment(id);
    const a = await docAccess(db, {
      userId: req.user?.id ?? null,
      documentId: c.documentId,
      shareToken: req.shareToken,
    });
    const v = viewerOf(req, a);
    const own = c.authorId
      ? c.authorId === v.userId
      : !!v.guestKeyHash && c.guestKeyHash === v.guestKeyHash;
    if (!own && !v.canManage) throw forbidden();
    await db.delete(comments).where(eq(comments.id, id));
    // Deleting the last comment removes the thread.
    const left = await db
      .select({ id: comments.id })
      .from(comments)
      .where(eq(comments.threadId, c.threadId))
      .limit(1);
    if (!left.length) await db.delete(commentThreads).where(eq(commentThreads.id, c.threadId));
    return { ok: true };
  });
}
