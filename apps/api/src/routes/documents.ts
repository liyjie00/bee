import type { FastifyInstance } from 'fastify';
import { and, desc, eq, isNull, max } from 'drizzle-orm';
import { z } from 'zod';
import { activity, documentEmbeds, documentViews, documents, type Db } from '@bee/db';
import { can, type ActivityItem, type DocumentType } from '@bee/shared';
import { docAccess, requireDocRole, type DocRow } from '../lib/access.js';
import { logActivity } from '../lib/activity.js';
import { CollabClient } from '../lib/collab.js';
import { deleteAll, describeBoard, diagramElements } from '../lib/diagram.js';
import { deriveCaches, markdownToYUpdate, yUpdateToMarkdown } from '../lib/content.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { documentDTO, loadUserRefs, refOr } from '../lib/dto.js';
import { idParams, parse } from '../lib/validate.js';
import { requireUser } from './auth.js';
import { requireCreateIn } from './folders.js';

const createBody = z.object({
  /** optional when parentDocumentId is given (taken from the parent) */
  workspaceId: z.uuid().optional(),
  /** embed in another document (e.g. a whiteboard inside a doc) */
  parentDocumentId: z.uuid().optional(),
  folderId: z.uuid().nullable().optional(),
  title: z.string().max(500).optional(),
  type: z.enum(['doc', 'whiteboard', 'sheet']).optional(),
  markdown: z.string().max(5_000_000).optional(),
});
const markdownEditBody = z.discriminatedUnion('mode', [
  z.object({ mode: z.enum(['replace', 'append']), markdown: z.string().max(5_000_000) }),
  z.object({
    mode: z.literal('str_replace'),
    find: z.string().min(1).max(1_000_000),
    replace: z.string().max(1_000_000),
    replaceAll: z.boolean().optional(),
  }),
]);
const diagramBody = z.object({
  nodes: z
    .array(
      z.object({
        id: z.string().min(1).max(100),
        label: z.string().max(2000),
        shape: z.enum(['rectangle', 'ellipse', 'diamond']).optional(),
        color: z.string().max(32).optional(),
        x: z.number().finite().optional(),
        y: z.number().finite().optional(),
      }),
    )
    .min(1)
    .max(300),
  edges: z
    .array(
      z.object({
        from: z.string().min(1).max(100),
        to: z.string().min(1).max(100),
        label: z.string().max(500).optional(),
        dashed: z.boolean().optional(),
      }),
    )
    .max(1000)
    .optional(),
  direction: z.enum(['down', 'right']).optional(),
  /** append: draw below what is there; replace: clear the board first */
  mode: z.enum(['append', 'replace']).optional(),
});
const updateBody = z.object({
  title: z.string().max(500).optional(),
  icon: z.string().max(64).nullable().optional(),
  folderId: z.uuid().nullable().optional(),
  sort: z.number().finite().optional(),
});

async function nextDocSort(db: Db, workspaceId: string, folderId: string | null) {
  const [r] = await db
    .select({ m: max(documents.sort) })
    .from(documents)
    .where(
      and(
        eq(documents.workspaceId, workspaceId),
        folderId ? eq(documents.folderId, folderId) : isNull(documents.folderId),
      ),
    );
  return (r?.m ?? 0) + 1;
}

/** First markdown heading, used as the title for imports without one. */
function titleFromMarkdown(md: string): string | undefined {
  const m = /^#{1,6}\s+(.+)$/m.exec(md);
  return m?.[1]?.trim().slice(0, 500);
}

/** Drops a leading `# Title` heading that just repeats the doc title, so imports don't show it twice. */
export function stripTitleHeading(md: string, title: string): string {
  const m = /^\s*#\s+(.+?)\s*#*\s*(?:\r?\n|$)/.exec(md);
  if (!m || !title || m[1]!.trim() !== title.trim()) return md;
  return md.slice(m[0].length).replace(/^\s*\n/, '');
}

export async function insertDocument(
  db: Db,
  v: {
    workspaceId: string;
    folderId: string | null;
    ownerId: string;
    title: string;
    type: DocumentType;
    state?: Uint8Array | null;
    icon?: string | null;
    parentDocumentId?: string | null;
  },
): Promise<DocRow> {
  const caches = v.state && v.type === 'doc' ? deriveCaches(v.state) : null;
  const [doc] = await db
    .insert(documents)
    .values({
      workspaceId: v.workspaceId,
      folderId: v.folderId,
      ownerId: v.ownerId,
      title: v.title,
      type: v.type,
      icon: v.icon ?? null,
      parentDocumentId: v.parentDocumentId ?? null,
      sort: await nextDocSort(db, v.workspaceId, v.folderId),
      ydocState: v.state ? Buffer.from(v.state) : null,
      markdownCache: caches?.markdown ?? null,
      textCache: caches?.text ?? null,
      blockIds: caches?.blockIds ?? [],
      lastEditedById: v.ownerId,
      contentUpdatedAt: v.state ? new Date() : null,
    })
    .returning();
  return doc!;
}

export async function documentRoutes(app: FastifyInstance) {
  const { db } = app;
  const collab = new CollabClient(app.config);

  const dto = async (doc: DocRow, role: Parameters<typeof documentDTO>[1]) => {
    const refs = await loadUserRefs(db, [doc.ownerId, doc.lastEditedById]);
    return documentDTO(doc, role, refs);
  };

  app.post('/documents', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(createBody, req.body);
    const type = body.type ?? 'doc';
    let workspaceId = body.workspaceId;
    let folderId = body.folderId ?? null;
    if (body.parentDocumentId) {
      const parent = await requireDocRole(
        db,
        { userId: user.id, documentId: body.parentDocumentId, shareToken: req.shareToken },
        can.edit,
        'You cannot edit the parent document',
      );
      workspaceId = parent.doc.workspaceId;
      folderId = parent.doc.folderId;
    } else {
      if (!workspaceId) throw badRequest('workspaceId is required', 'validation');
      await requireCreateIn(db, workspaceId, folderId, user.id);
    }
    if (body.markdown !== undefined && type !== 'doc')
      throw badRequest('Markdown import is only for docs');
    const title =
      body.title ?? (body.markdown ? titleFromMarkdown(body.markdown) : undefined) ?? '';
    const state =
      body.markdown !== undefined ? markdownToYUpdate(stripTitleHeading(body.markdown, title)) : null;
    const doc = await insertDocument(db, {
      workspaceId,
      folderId,
      ownerId: user.id,
      title,
      type,
      state,
      parentDocumentId: body.parentDocumentId ?? null,
    });
    await logActivity(db, {
      workspaceId: doc.workspaceId,
      documentId: doc.id,
      actorId: user.id,
      kind: 'created',
    });
    return reply.status(201).send({ document: await dto(doc, 'owner') });
  });

  app.get('/documents/:id', async (req) => {
    const { id } = parse(idParams, req.params);
    const userId = req.user?.id ?? null;
    const a = await docAccess(db, {
      userId,
      documentId: id,
      shareToken: req.shareToken,
      includeDeleted: true,
    });
    if (a.doc.deletedAt && !can.manage(a.role)) throw notFound('Document not found');
    if (userId) {
      await db
        .insert(documentViews)
        .values({ documentId: id, userId })
        .onConflictDoUpdate({
          target: [documentViews.documentId, documentViews.userId],
          set: { viewedAt: new Date() },
        });
    }
    return { document: await dto(a.doc, a.role) };
  });

  app.patch('/documents/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const body = parse(updateBody, req.body);
    const a = await requireDocRole(
      db,
      { userId: user.id, documentId: id },
      can.edit,
      'You cannot edit this document',
    );
    const patch: Partial<typeof documents.$inferInsert> = { updatedAt: new Date() };
    if (body.title !== undefined) patch.title = body.title;
    if (body.icon !== undefined) patch.icon = body.icon;
    if (body.sort !== undefined) patch.sort = body.sort;
    const moved = body.folderId !== undefined && body.folderId !== a.doc.folderId;
    if (moved) {
      // Moving changes who inherits access, so only the owner may do it.
      if (!can.manage(a.role)) throw forbidden('Only the owner can move this document');
      await requireCreateIn(db, a.doc.workspaceId, body.folderId ?? null, user.id);
      patch.folderId = body.folderId ?? null;
      if (body.sort === undefined)
        patch.sort = await nextDocSort(db, a.doc.workspaceId, patch.folderId);
    }
    const [doc] = await db.update(documents).set(patch).where(eq(documents.id, id)).returning();
    if (body.title !== undefined && body.title !== a.doc.title) {
      await logActivity(db, {
        workspaceId: doc!.workspaceId,
        documentId: id,
        actorId: user.id,
        kind: 'renamed',
        detail: body.title,
      });
    }
    if (moved)
      await logActivity(db, {
        workspaceId: doc!.workspaceId,
        documentId: id,
        actorId: user.id,
        kind: 'moved',
      });
    const after = await docAccess(db, { userId: user.id, documentId: id });
    return { document: await dto(doc!, after.role) };
  });

  app.delete('/documents/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const { permanent } = parse(z.object({ permanent: z.coerce.boolean().optional() }), req.query);
    const a = await docAccess(db, { userId: user.id, documentId: id, includeDeleted: true });
    if (!can.manage(a.role)) throw forbidden('Only the owner can delete this document');
    if (permanent) {
      if (!a.doc.deletedAt) throw badRequest('Move the document to the trash first');
      await db.delete(documents).where(eq(documents.id, id));
    } else if (!a.doc.deletedAt) {
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, id));
    }
    return { ok: true };
  });

  app.post('/documents/:id/restore', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const a = await docAccess(db, { userId: user.id, documentId: id, includeDeleted: true });
    if (!can.manage(a.role)) throw forbidden();
    const [doc] = await db
      .update(documents)
      .set({ deletedAt: null })
      .where(eq(documents.id, id))
      .returning();
    return { document: await dto(doc!, a.role) };
  });

  app.post('/documents/:id/duplicate', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const a = await docAccess(db, { userId: user.id, documentId: id, shareToken: req.shareToken });
    const sameWorkspace = !!a.workspaceRole;
    if (!sameWorkspace) throw forbidden('Join the workspace to duplicate this document');
    let folderId = a.doc.folderId;
    try {
      await requireCreateIn(db, a.doc.workspaceId, folderId, user.id);
    } catch {
      folderId = null;
    }
    const doc = await insertDocument(db, {
      workspaceId: a.doc.workspaceId,
      folderId,
      ownerId: user.id,
      title: `${a.doc.title || 'Untitled'} (copy)`,
      type: a.doc.type,
      icon: a.doc.icon,
      state: a.doc.ydocState,
    });
    await logActivity(db, {
      workspaceId: doc.workspaceId,
      documentId: doc.id,
      actorId: user.id,
      kind: 'created',
    });
    return reply.status(201).send({ document: await dto(doc, 'owner') });
  });

  // Link a standalone whiteboard into this document, so the document's readers can view it there.
  app.post('/documents/:id/embeds', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const { documentId: embeddedId } = parse(z.object({ documentId: z.uuid() }), req.body);
    const host = await requireDocRole(
      db,
      { userId: user.id, documentId: id, shareToken: req.shareToken },
      can.edit,
      'You cannot edit this document',
    );
    const board = await docAccess(db, { userId: user.id, documentId: embeddedId, direct: true });
    if (board.doc.type !== 'whiteboard') throw badRequest('Only whiteboards can be embedded');
    if (board.doc.parentDocumentId) throw badRequest('This whiteboard belongs to another document');
    if (board.doc.workspaceId !== host.doc.workspaceId)
      throw badRequest('The whiteboard is in another workspace');
    if (embeddedId === id) throw badRequest('A document cannot embed itself');
    await db
      .insert(documentEmbeds)
      .values({ documentId: id, embeddedId, createdById: user.id })
      .onConflictDoNothing();
    return { ok: true };
  });

  /**
   * Stored Yjs state, so clients can render a document before their collab sync completes.
   * It may trail the live collab state by the store debounce; the sync fills in the rest.
   */
  app.get('/documents/:id/state', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const a = await docAccess(db, {
      userId: req.user?.id ?? null,
      documentId: id,
      shareToken: req.shareToken,
      includeDeleted: true,
    });
    if (a.doc.deletedAt && !can.manage(a.role)) throw notFound('Document not found');
    if (!a.doc.ydocState?.length) return reply.status(204).send();
    return reply
      .header('content-type', 'application/octet-stream')
      .header('cache-control', 'private, no-store')
      .send(a.doc.ydocState);
  });

  app.get('/documents/:id/export.md', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const a = await docAccess(db, {
      userId: req.user?.id ?? null,
      documentId: id,
      shareToken: req.shareToken,
    });
    if (a.doc.type !== 'doc') throw badRequest('Only docs can be exported as Markdown');
    const md = a.doc.ydocState ? yUpdateToMarkdown(a.doc.ydocState) : '';
    const body = (a.doc.title ? `# ${a.doc.title}\n\n` : '') + md;
    const filename =
      (a.doc.title || 'untitled').replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, 100) || 'untitled';
    return reply
      .header('content-type', 'text/markdown; charset=utf-8')
      .header(
        'content-disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(filename)}.md`,
      )
      .send(body);
  });

  app.get('/documents/:id/markdown', async (req) => {
    const { id } = parse(idParams, req.params);
    const a = await docAccess(db, {
      userId: req.user?.id ?? null,
      documentId: id,
      shareToken: req.shareToken,
    });
    if (a.doc.type !== 'doc') throw badRequest('Only docs have Markdown content');
    return { documentId: id, title: a.doc.title, markdown: await collab.readMarkdown(id) };
  });

  app.post('/documents/:id/markdown', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const body = parse(markdownEditBody, req.body);
    const a = await requireDocRole(
      db,
      { userId: user.id, documentId: id, shareToken: req.shareToken },
      can.edit,
      'You cannot edit this document',
    );
    if (a.doc.type !== 'doc') throw badRequest('Only docs can be edited as Markdown');
    const r = await collab.editMarkdown(id, body, user.id);
    return { documentId: id, title: a.doc.title, ...r };
  });

  app.get('/documents/:id/whiteboard', async (req) => {
    const { id } = parse(idParams, req.params);
    const a = await docAccess(db, {
      userId: req.user?.id ?? null,
      documentId: id,
      shareToken: req.shareToken,
    });
    if (a.doc.type !== 'whiteboard') throw badRequest('This document is not a whiteboard');
    const elements = (await collab.whiteboardElements(id)).filter((e) => !e.isDeleted);
    return { documentId: id, title: a.doc.title, description: describeBoard(elements), elements };
  });

  /** Draws a node/edge diagram on a whiteboard as a live edit. */
  app.post('/documents/:id/diagram', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const body = parse(diagramBody, req.body);
    const a = await requireDocRole(
      db,
      { userId: user.id, documentId: id, shareToken: req.shareToken },
      can.edit,
      'You cannot edit this whiteboard',
    );
    if (a.doc.type !== 'whiteboard') throw badRequest('This document is not a whiteboard');
    const existing = await collab.whiteboardElements(id);
    const removed = body.mode === 'replace' ? deleteAll(existing) : [];
    let added;
    try {
      // Replacing starts at the origin, but indices still follow the deleted elements.
      added = diagramElements(body, body.mode === 'replace' ? [] : existing, existing);
    } catch (err) {
      throw badRequest((err as Error).message, 'validation');
    }
    await collab.putWhiteboardElements(id, [...removed, ...added], user.id);
    return {
      documentId: id,
      added: added.length,
      removed: removed.length,
      shapes: added.filter((e) => e.type !== 'text' && e.type !== 'arrow').length,
      arrows: added.filter((e) => e.type === 'arrow').length,
    };
  });

  app.get('/documents/:id/blocks/:blockId', async (req) => {
    const { id, blockId } = parse(
      z.object({ id: z.uuid(), blockId: z.string().min(1).max(64) }),
      req.params,
    );
    const a = await docAccess(db, {
      userId: req.user?.id ?? null,
      documentId: id,
      shareToken: req.shareToken,
    });
    return { documentId: id, blockId, exists: a.doc.blockIds.includes(blockId) };
  });

  app.get('/documents/:id/activity', async (req) => {
    const { id } = parse(idParams, req.params);
    await docAccess(db, {
      userId: req.user?.id ?? null,
      documentId: id,
      shareToken: req.shareToken,
    });
    const rows = await db
      .select()
      .from(activity)
      .where(eq(activity.documentId, id))
      .orderBy(desc(activity.createdAt))
      .limit(100);
    const refs = await loadUserRefs(
      db,
      rows.map((r) => r.actorId),
    );
    const items: ActivityItem[] = rows.map((r) => ({
      id: r.id,
      kind: r.kind as ActivityItem['kind'],
      actor: r.actorId ? refOr(refs, r.actorId) : null,
      createdAt: r.createdAt.toISOString(),
      detail: r.detail,
    }));
    return { items };
  });
}
