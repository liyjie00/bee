import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  accessRequests,
  documents,
  folders,
  notifications,
  permissions,
  templates,
  users,
  type Db,
} from '@bee/db';
import {
  can,
  GRANTABLE_ROLES,
  guestColor,
  type AccessRequestDTO,
  type NotificationDTO,
  type TemplateDTO,
} from '@bee/shared';
import { docAccess, requireMember } from '../lib/access.js';
import { logActivity } from '../lib/activity.js';
import { docReaders, notifyShare } from '../lib/notify.js';
import {
  deletePushSubscription,
  deliveryEnabled,
  insertNotifications,
  langOf,
  pushTest,
  savePushSubscription,
} from '../lib/delivery.js';
import { yUpdateToMarkdown } from '../lib/content.js';
import { badRequest, forbidden, HttpError, notFound } from '../lib/errors.js';
import { loadUserRefs, refOr } from '../lib/dto.js';
import { idParams, parse } from '../lib/validate.js';
import { requireUser } from './auth.js';

const PAGE = 50;
type RequestRow = typeof accessRequests.$inferSelect;

async function requestDTOs(db: Db, rows: RequestRow[]): Promise<Map<string, AccessRequestDTO>> {
  const ids = [...new Set(rows.map((r) => r.userId))];
  const people = ids.length
    ? await db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          avatarUrl: users.avatarUrl,
          color: users.color,
        })
        .from(users)
        .where(inArray(users.id, ids))
    : [];
  const byId = new Map(people.map((p) => [p.id, p]));
  const out = new Map<string, AccessRequestDTO>();
  for (const r of rows) {
    const u = byId.get(r.userId);
    if (!u) continue;
    out.set(r.id, {
      id: r.id,
      documentId: r.documentId,
      user: u,
      role: r.role,
      message: r.message,
      status: r.status,
      grantedRole: r.grantedRole,
      createdAt: r.createdAt.toISOString(),
    });
  }
  return out;
}

async function unreadCount(db: Db, userId: string): Promise<number> {
  const [r] = await db
    .select({ n: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));
  return r?.n ?? 0;
}

export async function notificationRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get('/notifications', async (req) => {
    const user = requireUser(req);
    const q = parse(
      z.object({ unread: z.enum(['0', '1']).optional(), before: z.iso.datetime().optional() }),
      req.query,
    );
    const cond = [eq(notifications.userId, user.id)];
    if (q.unread === '1') cond.push(isNull(notifications.readAt));
    if (q.before) cond.push(lt(notifications.createdAt, new Date(q.before)));
    const rows = await db
      .select()
      .from(notifications)
      .where(and(...cond))
      .orderBy(desc(notifications.createdAt))
      .limit(PAGE);
    const docIds = [...new Set(rows.map((r) => r.documentId).filter((x): x is string => !!x))];
    const folderIds = [...new Set(rows.map((r) => r.folderId).filter((x): x is string => !!x))];
    const reqIds = [...new Set(rows.map((r) => r.requestId).filter((x): x is string => !!x))];
    const [docs, fols, refs, reqRows] = await Promise.all([
      docIds.length
        ? db
            .select({
              id: documents.id,
              title: documents.title,
              type: documents.type,
              deletedAt: documents.deletedAt,
            })
            .from(documents)
            .where(inArray(documents.id, docIds))
        : [],
      folderIds.length
        ? db
            .select({ id: folders.id, name: folders.name })
            .from(folders)
            .where(inArray(folders.id, folderIds))
        : [],
      loadUserRefs(
        db,
        rows.map((r) => r.actorId),
      ),
      reqIds.length
        ? db.select().from(accessRequests).where(inArray(accessRequests.id, reqIds))
        : [],
    ]);
    const reqs = await requestDTOs(db, reqRows);
    const docById = new Map(docs.map((d) => [d.id, d]));
    const folderById = new Map(fols.map((f) => [f.id, f]));
    const list: NotificationDTO[] = [];
    for (const r of rows) {
      const d = r.documentId ? docById.get(r.documentId) : undefined;
      // Documents in the trash drop out of the inbox.
      if (r.documentId && (!d || d.deletedAt)) continue;
      const name = r.actorName ?? 'Guest';
      list.push({
        id: r.id,
        kind: r.kind,
        actor: r.actorId
          ? refOr(refs, r.actorId)
          : { id: '', name, avatarUrl: null, color: guestColor(name) },
        document: d ? { id: d.id, title: d.title, type: d.type } : null,
        folder: r.folderId ? (folderById.get(r.folderId) ?? null) : null,
        threadId: r.threadId,
        detail: r.detail,
        request: r.requestId ? (reqs.get(r.requestId) ?? null) : null,
        read: !!r.readAt,
        createdAt: r.createdAt.toISOString(),
      });
    }
    return { notifications: list, unread: await unreadCount(db, user.id) };
  });

  app.get('/notifications/unread', async (req) => {
    const user = requireUser(req);
    return { unread: await unreadCount(db, user.id) };
  });

  app.post('/notifications/read', async (req) => {
    const user = requireUser(req);
    const b = parse(
      z.object({ ids: z.array(z.uuid()).max(500).optional(), all: z.boolean().optional() }),
      req.body,
    );
    if (!b.all && !b.ids?.length) throw badRequest('Provide ids or all: true', 'validation');
    const cond = [eq(notifications.userId, user.id), isNull(notifications.readAt)];
    if (!b.all) cond.push(inArray(notifications.id, b.ids!));
    await db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(...cond));
    return { unread: await unreadCount(db, user.id) };
  });

  // ---------- email and browser delivery ----------

  app.get('/notifications/delivery', async (req) => {
    requireUser(req);
    return deliveryEnabled();
  });

  const subBody = z.object({
    endpoint: z.url().max(2000),
    keys: z.object({ p256dh: z.string().min(1).max(200), auth: z.string().min(1).max(100) }),
  });
  app.post('/push-subscriptions', async (req) => {
    const user = requireUser(req);
    await savePushSubscription(db, user.id, parse(subBody, req.body));
    return { ok: true };
  });
  app.post('/push-subscriptions/remove', async (req) => {
    const user = requireUser(req);
    const { endpoint } = parse(z.object({ endpoint: z.string().max(2000) }), req.body);
    await deletePushSubscription(db, user.id, endpoint);
    return { ok: true };
  });
  app.post(
    '/push-subscriptions/test',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (req) => {
      const user = requireUser(req);
      await pushTest(db, user.id, langOf(user.prefs));
      return { ok: true };
    },
  );

  // ---------- access requests ----------

  app.post(
    '/documents/:id/access-requests',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const user = requireUser(req);
      const { id } = parse(idParams, req.params);
      const b = parse(
        z.object({
          role: z.enum(GRANTABLE_ROLES),
          message: z.string().trim().max(1000).optional(),
        }),
        req.body,
      );
      const [doc] = await db
        .select({
          id: documents.id,
          deletedAt: documents.deletedAt,
          parent: documents.parentDocumentId,
        })
        .from(documents)
        .where(eq(documents.id, id));
      if (!doc || doc.deletedAt || doc.parent) throw notFound('Document not found');
      try {
        await docAccess(db, { userId: user.id, documentId: id, direct: true });
        throw new HttpError(409, 'already_has_access', 'You already have access');
      } catch (e) {
        if (e instanceof HttpError && e.status === 409) throw e;
      }
      const [existing] = await db
        .select()
        .from(accessRequests)
        .where(and(eq(accessRequests.documentId, id), eq(accessRequests.userId, user.id)));
      // Asking again within a minute updates the request without notifying everyone again.
      const quiet =
        existing?.status === 'pending' && existing.createdAt.getTime() > Date.now() - 60_000;
      const [r] = await db
        .insert(accessRequests)
        .values({ documentId: id, userId: user.id, role: b.role, message: b.message || null })
        .onConflictDoUpdate({
          target: [accessRequests.documentId, accessRequests.userId],
          set: {
            role: b.role,
            message: b.message || null,
            status: 'pending',
            grantedRole: null,
            handledById: null,
            handledAt: null,
            ...(quiet ? {} : { createdAt: new Date() }),
          },
        })
        .returning();
      if (!quiet) {
        await db.delete(notifications).where(eq(notifications.requestId, r!.id));
        // Everyone who may share the document decides: its owner and editors.
        const [owner] = await db.select().from(documents).where(eq(documents.id, id));
        const a = await docAccess(db, { userId: owner!.ownerId, documentId: id });
        const editors = await editorsOf(a);
        if (editors.length)
          await insertNotifications(
            db,
            editors.map((userId) => ({
              userId,
              workspaceId: a.doc.workspaceId,
              kind: 'access_request' as const,
              documentId: id,
              requestId: r!.id,
              actorId: user.id,
              detail: b.message || null,
            })),
          );
      }
      const dto = (await requestDTOs(db, [r!])).get(r!.id)!;
      return reply.status(201).send({ request: dto });
    },
  );

  const editorsOf = async (a: Awaited<ReturnType<typeof docAccess>>) => {
    const readers = await docReaders(db, a, { minRole: 'editor' });
    return readers.map((r) => r.id);
  };

  app.get('/documents/:id/access-requests/mine', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const [r] = await db
      .select()
      .from(accessRequests)
      .where(and(eq(accessRequests.documentId, id), eq(accessRequests.userId, user.id)));
    return { request: r ? ((await requestDTOs(db, [r])).get(r.id) ?? null) : null };
  });

  app.post('/access-requests/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const b = parse(
      z.discriminatedUnion('action', [
        z.object({ action: z.literal('grant'), role: z.enum(GRANTABLE_ROLES) }),
        z.object({ action: z.literal('decline') }),
      ]),
      req.body,
    );
    const [r] = await db.select().from(accessRequests).where(eq(accessRequests.id, id));
    if (!r) throw notFound('Request not found');
    const a = await docAccess(db, { userId: user.id, documentId: r.documentId });
    if (!can.edit(a.role)) throw forbidden('Only editors can share this document');
    if (b.action === 'grant') {
      await db
        .insert(permissions)
        .values({
          workspaceId: a.doc.workspaceId,
          resourceType: 'document',
          resourceId: r.documentId,
          principalType: 'user',
          principalId: r.userId,
          role: b.role,
          createdById: user.id,
        })
        .onConflictDoUpdate({
          target: [
            permissions.resourceType,
            permissions.resourceId,
            permissions.principalType,
            permissions.principalId,
          ],
          set: { role: b.role },
        });
      const [target] = await db
        .select({ name: users.name })
        .from(users)
        .where(eq(users.id, r.userId));
      await logActivity(db, {
        workspaceId: a.doc.workspaceId,
        documentId: r.documentId,
        actorId: user.id,
        kind: 'shared',
        detail: `${target?.name ?? ''}: ${b.role}`,
      });
      await notifyShare(db, {
        userId: r.userId,
        actorId: user.id,
        workspaceId: a.doc.workspaceId,
        documentId: r.documentId,
        role: b.role,
      });
    }
    const [nr] = await db
      .update(accessRequests)
      .set({
        status: b.action === 'grant' ? 'granted' : 'declined',
        grantedRole: b.action === 'grant' ? b.role : null,
        handledById: user.id,
        handledAt: new Date(),
      })
      .where(eq(accessRequests.id, id))
      .returning();
    // Handled for everyone it was sent to.
    await db
      .update(notifications)
      .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
      .where(eq(notifications.requestId, id));
    return { request: (await requestDTOs(db, [nr!])).get(id) ?? null };
  });

  // ---------- templates ----------

  const templateDTO = (
    t: typeof templates.$inferSelect,
    refs: Map<string, ReturnType<typeof refOr>>,
    canDelete: boolean,
  ): TemplateDTO => ({
    id: t.id,
    workspaceId: t.workspaceId,
    title: t.title,
    markdown: t.markdown,
    createdBy: t.createdById ? refOr(refs, t.createdById) : null,
    canDelete,
    createdAt: t.createdAt.toISOString(),
  });
  const mayDelete = (t: typeof templates.$inferSelect, userId: string, role: string) =>
    t.createdById === userId || role === 'owner' || role === 'admin';

  app.get('/workspaces/:id/templates', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const role = await requireMember(db, id, user.id);
    const rows = await db
      .select()
      .from(templates)
      .where(eq(templates.workspaceId, id))
      .orderBy(desc(templates.createdAt))
      .limit(200);
    const refs = await loadUserRefs(
      db,
      rows.map((r) => r.createdById),
    );
    return { templates: rows.map((t) => templateDTO(t, refs, mayDelete(t, user.id, role))) };
  });

  // Saves the document's current content as a template of its workspace.
  app.post('/documents/:id/template', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const b = parse(z.object({ title: z.string().trim().max(200).optional() }), req.body ?? {});
    const a = await docAccess(db, { userId: user.id, documentId: id });
    if (!a.workspaceRole) throw forbidden('Join the workspace to save templates');
    if (a.doc.type !== 'doc') throw badRequest('Only docs can be saved as templates');
    const markdown = a.doc.ydocState ? yUpdateToMarkdown(a.doc.ydocState) : '';
    const [t] = await db
      .insert(templates)
      .values({
        workspaceId: a.doc.workspaceId,
        title: b.title || a.doc.title || 'Untitled',
        markdown,
        createdById: user.id,
      })
      .returning();
    const refs = await loadUserRefs(db, [user.id]);
    return reply.status(201).send({ template: templateDTO(t!, refs, true) });
  });

  app.delete('/templates/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const [t] = await db.select().from(templates).where(eq(templates.id, id));
    if (!t) throw notFound('Template not found');
    const role = await requireMember(db, t.workspaceId, user.id);
    if (!mayDelete(t, user.id, role)) throw forbidden('Only its creator or an admin can delete it');
    await db.delete(templates).where(eq(templates.id, id));
    return { ok: true };
  });
}
