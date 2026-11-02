import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { commentThreads, comments, type Db } from '@bee/db';
import { can, type CommentDTO, type CommentThreadDTO } from '@bee/shared';
import { docAccess } from '../lib/access.js';
import { logActivity } from '../lib/activity.js';
import { forbidden, notFound } from '../lib/errors.js';
import { loadUserRefs, refOr } from '../lib/dto.js';
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

async function threadDTOs(
  db: Db,
  threads: ThreadRow[],
  all: CommentRow[],
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
      comments: list.map((c, i) => commentDTO(c, refs, i === 0 ? (t.anchor ?? null) : null)),
    };
  });
}

function commentDTO(
  c: CommentRow,
  refs: Map<string, ReturnType<typeof refOr>>,
  a: CommentDTO['anchor'],
): CommentDTO {
  return {
    id: c.id,
    documentId: c.documentId,
    threadId: c.threadId,
    anchor: a,
    body: c.body,
    author: refOr(refs, c.authorId),
    createdAt: c.createdAt.toISOString(),
    editedAt: c.editedAt?.toISOString() ?? null,
  };
}

export async function commentRoutes(app: FastifyInstance) {
  const { db } = app;

  const loadThread = async (tid: string) => {
    const [t] = await db.select().from(commentThreads).where(eq(commentThreads.id, tid));
    if (!t) throw notFound('Thread not found');
    return t;
  };
  const threadWithComments = async (t: ThreadRow) => {
    const list = await db
      .select()
      .from(comments)
      .where(eq(comments.threadId, t.id))
      .orderBy(asc(comments.createdAt));
    return (await threadDTOs(db, [t], list))[0]!;
  };

  app.get('/documents/:id/threads', async (req) => {
    const { id } = parse(idParams, req.params);
    const { resolved } = parse(z.object({ resolved: z.enum(['0', '1']).optional() }), req.query);
    await docAccess(db, {
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
    return { threads: await threadDTOs(db, threads, list) };
  });

  app.post('/documents/:id/threads', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ anchor, body }), req.body);
    const a = await docAccess(db, { userId: user.id, documentId: id, shareToken: req.shareToken });
    if (!can.comment(a.role)) throw forbidden('You cannot comment on this document');
    const t = await db.transaction(async (tx) => {
      const [t] = await tx
        .insert(commentThreads)
        .values({ documentId: id, anchor: b.anchor ?? null, createdById: user.id })
        .returning();
      await tx
        .insert(comments)
        .values({ threadId: t!.id, documentId: id, authorId: user.id, body: b.body });
      return t!;
    });
    await logActivity(db, {
      workspaceId: a.doc.workspaceId,
      documentId: id,
      actorId: user.id,
      kind: 'commented',
      detail: b.body.slice(0, 200),
    });
    return reply.status(201).send({ thread: await threadWithComments(t) });
  });

  app.post('/threads/:id/comments', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ body }), req.body);
    const t = await loadThread(id);
    const a = await docAccess(db, {
      userId: user.id,
      documentId: t.documentId,
      shareToken: req.shareToken,
    });
    if (!can.comment(a.role)) throw forbidden('You cannot comment on this document');
    const [c] = await db
      .insert(comments)
      .values({ threadId: id, documentId: t.documentId, authorId: user.id, body: b.body })
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
      actorId: user.id,
      kind: 'commented',
      detail: b.body.slice(0, 200),
    });
    const refs = await loadUserRefs(db, [user.id]);
    return reply.status(201).send({ comment: commentDTO(c!, refs, null) });
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
    return { thread: await threadWithComments(nt!) };
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
    await docAccess(db, { userId: user.id, documentId: c.documentId, shareToken: req.shareToken });
    if (c.authorId !== user.id) throw forbidden('You can only edit your own comments');
    const [nc] = await db
      .update(comments)
      .set({ body: b.body, editedAt: new Date() })
      .where(eq(comments.id, id))
      .returning();
    const refs = await loadUserRefs(db, [user.id]);
    return { comment: commentDTO(nc!, refs, null) };
  });

  app.delete('/comments/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const c = await loadComment(id);
    const a = await docAccess(db, {
      userId: user.id,
      documentId: c.documentId,
      shareToken: req.shareToken,
    });
    if (c.authorId !== user.id && !can.manage(a.role)) throw forbidden();
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
