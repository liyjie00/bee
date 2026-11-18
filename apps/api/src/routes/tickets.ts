/* Tickets: list, create, edit, bulk edit, delete; comments, watchers, links and documents. */
import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  documents,
  projectStatuses,
  projects,
  sprints,
  ticketComments,
  ticketDocuments,
  ticketEvents,
  ticketLinks,
  ticketWatchers,
  tickets,
  uploads,
  workspaceMembers,
  type Db,
} from '@bee/db';
import {
  LINK_KINDS,
  PRIORITIES,
  RESOLUTIONS,
  TICKET_TYPES,
  compareTickets,
  matchesFilter,
  parseTicketKey,
  type TicketDetailDTO,
  type TicketDTO,
  type TicketFilter,
} from '@bee/shared';
import { docAccess } from '../lib/access.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { loadUserRefs } from '../lib/dto.js';
import {
  createTicket,
  deleteTicket,
  projectContext,
  updateTicket,
  type TicketInput,
} from '../lib/ticket-ops.js';
import {
  logEvents,
  notifyTicket,
  projectAccess,
  ticketAccess,
  ticketDTOs,
  ticketRefs,
  watch,
  watcherIds,
  workspaceUsers,
  userRefList,
  type ProjectRow,
} from '../lib/tickets.js';
import { idParams, parse } from '../lib/validate.js';
import { requireUser } from './auth.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const minutes = z.number().int().min(0).max(1_000_000).nullable();

export const ticketInput = z.object({
  type: z.enum(TICKET_TYPES).optional(),
  title: z.string().trim().min(1).max(500).optional(),
  description: z.string().max(200_000).optional(),
  parentId: z.uuid().nullable().optional(),
  statusId: z.uuid().optional(),
  priority: z.enum(PRIORITIES).optional(),
  assigneeId: z.uuid().nullable().optional(),
  reporterId: z.uuid().nullable().optional(),
  sprintId: z.uuid().nullable().optional(),
  storyPoints: z.number().min(0).max(1000).nullable().optional(),
  estimateMinutes: minutes.optional(),
  spentMinutes: minutes.optional(),
  startDate: date.nullable().optional(),
  dueDate: date.nullable().optional(),
  rank: z.number().finite().optional(),
  resolution: z.enum(RESOLUTIONS).nullable().optional(),
  labelIds: z.array(z.uuid()).max(50).optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
});

const filterSchema = z
  .object({
    q: z.string().max(200).optional(),
    types: z.array(z.enum(TICKET_TYPES)).optional(),
    statusIds: z.array(z.uuid()).optional(),
    categories: z.array(z.enum(['todo', 'doing', 'done'])).optional(),
    assignees: z.array(z.string().max(40)).optional(),
    priorities: z.array(z.enum(PRIORITIES)).optional(),
    labelIds: z.array(z.uuid()).optional(),
    sprint: z.string().max(40).optional(),
    epicId: z.uuid().optional(),
    due: z.enum(['overdue', 'week', 'none']).optional(),
    fields: z.record(z.string(), z.union([z.string().max(200), z.boolean()])).optional(),
  })
  .default({});

/** Mentioned workspace members ("@Name" in the text), longest names first. */
function mentioned(text: string, people: { id: string; name: string }[]) {
  let rest = text;
  const out: string[] = [];
  for (const p of [...people].sort((a, b) => b.name.length - a.name.length)) {
    const tag = '@' + p.name;
    if (!p.name || !rest.includes(tag)) continue;
    out.push(p.id);
    rest = rest.split(tag).join(' ');
  }
  return out;
}

/** Tickets the user can see matching a filter, across the given projects. */
export async function searchTickets(
  db: Db,
  userId: string,
  projectRows: ProjectRow[],
  filter: TicketFilter,
  opts: { sortBy?: Parameters<typeof compareTickets>[0]; limit?: number } = {},
): Promise<TicketDTO[]> {
  if (!projectRows.length) return [];
  const ids = projectRows.map((p) => p.id);
  const [rows, statuses, active] = await Promise.all([
    db
      .select()
      .from(tickets)
      .where(and(inArray(tickets.projectId, ids), isNull(tickets.deletedAt))),
    db.select().from(projectStatuses).where(inArray(projectStatuses.projectId, ids)),
    db
      .select({ id: sprints.id })
      .from(sprints)
      .where(and(inArray(sprints.projectId, ids), eq(sprints.state, 'active'))),
  ]);
  const parent = new Map(rows.map((r) => [r.id, r.parentId]));
  const ctx = {
    userId,
    statuses: new Map(statuses.map((s) => [s.id, { category: s.category }])),
    activeSprintIds: new Set(active.map((s) => s.id)),
    parentOf: (id: string) => parent.get(id) ?? null,
    today: new Date().toISOString().slice(0, 10),
  };
  // Cheap prefilter on rows, then the shared matcher on DTOs.
  const dtos = await ticketDTOs(db, rows);
  const list = dtos.filter((t) => matchesFilter(t, filter, ctx));
  list.sort(compareTickets(opts.sortBy ?? 'rank'));
  return opts.limit ? list.slice(0, opts.limit) : list;
}

/** Projects of every workspace the user belongs to (or one workspace). */
export async function visibleProjects(db: Db, userId: string, workspaceId?: string) {
  const rows = await db
    .select({ p: projects })
    .from(projects)
    .innerJoin(
      workspaceMembers,
      and(
        eq(workspaceMembers.workspaceId, projects.workspaceId),
        eq(workspaceMembers.userId, userId),
      ),
    )
    .where(workspaceId ? eq(projects.workspaceId, workspaceId) : undefined)
    .orderBy(asc(projects.name));
  return rows.map((r) => r.p);
}

export async function ticketDetail(
  db: Db,
  ticketId: string,
  userId: string,
): Promise<TicketDetailDTO> {
  const a = await ticketAccess(db, ticketId, userId);
  const t = a.ticket;
  const [[dto], childRows, outLinks, inLinks, docRows, watcherRows, commentRows, eventRows, files] =
    await Promise.all([
      ticketDTOs(db, [t]),
      db
        .select()
        .from(tickets)
        .where(and(eq(tickets.parentId, t.id), isNull(tickets.deletedAt)))
        .orderBy(asc(tickets.rank)),
      db.select().from(ticketLinks).where(eq(ticketLinks.fromId, t.id)),
      db.select().from(ticketLinks).where(eq(ticketLinks.toId, t.id)),
      db
        .select({
          id: documents.id,
          title: documents.title,
          type: documents.type,
          source: ticketDocuments.source,
          deletedAt: documents.deletedAt,
        })
        .from(ticketDocuments)
        .innerJoin(documents, eq(documents.id, ticketDocuments.documentId))
        .where(eq(ticketDocuments.ticketId, t.id)),
      db.select().from(ticketWatchers).where(eq(ticketWatchers.ticketId, t.id)),
      db
        .select()
        .from(ticketComments)
        .where(eq(ticketComments.ticketId, t.id))
        .orderBy(asc(ticketComments.createdAt)),
      db
        .select()
        .from(ticketEvents)
        .where(eq(ticketEvents.ticketId, t.id))
        .orderBy(desc(ticketEvents.createdAt))
        .limit(200),
      db
        .select()
        .from(uploads)
        .where(eq(uploads.ticketId, t.id))
        .orderBy(asc(uploads.createdAt)),
    ]);
  const refs = await ticketRefs(db, [
    ...(t.parentId ? [t.parentId] : []),
    ...outLinks.map((l) => l.toId),
    ...inLinks.map((l) => l.fromId),
  ]);
  const people = await loadUserRefs(db, [
    ...watcherRows.map((w) => w.userId),
    ...commentRows.map((c) => c.authorId),
    ...eventRows.map((e) => e.actorId),
  ]);
  // Only documents the reader can open.
  const docs = [];
  const seen = new Set<string>();
  for (const d of docRows) {
    if (d.deletedAt || seen.has(d.id)) continue;
    const ok = await docAccess(db, { userId, documentId: d.id }).then(
      () => true,
      () => false,
    );
    if (!ok) continue;
    seen.add(d.id);
    docs.push({ id: d.id, title: d.title, type: d.type, source: d.source });
  }
  const links = [
    ...outLinks.map((l) => ({
      id: l.id,
      kind: l.kind,
      direction: 'out' as const,
      ticket: refs.get(l.toId),
    })),
    ...inLinks.map((l) => ({
      id: l.id,
      kind: l.kind,
      direction: 'in' as const,
      ticket: refs.get(l.fromId),
    })),
  ].filter((l): l is typeof l & { ticket: NonNullable<typeof l.ticket> } => !!l.ticket);
  const p = a.project;
  return {
    ...dto!,
    project: { id: p.id, key: p.key, name: p.name, color: p.color, workspaceId: p.workspaceId },
    parent: t.parentId ? (refs.get(t.parentId) ?? null) : null,
    children: await ticketDTOs(db, childRows),
    links,
    documents: docs,
    attachments: files.map((f) => ({
      id: f.id,
      url: `/api/uploads/${f.id}`,
      filename: f.filename,
      mime: f.mime,
      size: f.size,
      createdAt: f.createdAt.toISOString(),
    })),
    watchers: userRefList(
      people,
      watcherRows.map((w) => w.userId),
    ),
    watching: watcherRows.some((w) => w.userId === userId),
    comments: commentRows.map((c) => ({
      id: c.id,
      author: c.authorId ? (people.get(c.authorId) ?? null) : null,
      body: c.body,
      createdAt: c.createdAt.toISOString(),
      editedAt: c.editedAt?.toISOString() ?? null,
      mine: c.authorId === userId,
    })),
    events: eventRows.map((e) => ({
      id: e.id,
      actor: e.actorId ? (people.get(e.actorId) ?? null) : null,
      field: e.field,
      from: e.from,
      to: e.to,
      createdAt: e.createdAt.toISOString(),
    })),
    canEdit: a.canEdit,
    canComment: !p.archivedAt,
  };
}

export async function ticketRoutes(app: FastifyInstance) {
  const { db } = app;

  /** All tickets of a project, or those changed since a time (for live refresh). */
  app.get('/projects/:id/tickets', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    await projectAccess(db, id, user.id);
    const q = parse(z.object({ since: z.iso.datetime().optional() }), req.query);
    const now = new Date();
    const since = q.since ? new Date(q.since) : null;
    const rows = await db
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.projectId, id),
          since ? gt(tickets.updatedAt, since) : isNull(tickets.deletedAt),
        ),
      )
      .orderBy(asc(tickets.rank));
    const live = rows.filter((r) => !r.deletedAt);
    return {
      tickets: await ticketDTOs(db, live),
      deleted: rows.filter((r) => r.deletedAt).map((r) => r.id),
      now: now.toISOString(),
    };
  });

  app.post('/projects/:id/tickets', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const a = await projectAccess(db, id, user.id);
    if (!a.canEdit) throw forbidden();
    const b = parse(
      ticketInput.extend({
        type: z.enum(TICKET_TYPES).default('task'),
        title: z.string().trim().min(1).max(500),
        documentId: z.uuid().optional(),
        watcherIds: z.array(z.uuid()).max(50).optional(),
      }),
      req.body,
    );
    const ctx = await projectContext(db, a.project);
    const row = await createTicket(
      db,
      ctx,
      b as TicketInput & { type: typeof b.type; title: string },
      user.id,
    );
    if (b.documentId) {
      await docAccess(db, { userId: user.id, documentId: b.documentId });
      await db
        .insert(ticketDocuments)
        .values({ ticketId: row.id, documentId: b.documentId, source: 'manual' })
        .onConflictDoNothing();
    }
    if (b.watcherIds?.length)
      await watch(
        db,
        row.id,
        b.watcherIds.filter((w) => ctx.memberIds.has(w)),
      );
    reply.status(201);
    return { ticket: (await ticketDTOs(db, [row]))[0] };
  });

  app.get('/tickets/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    return { ticket: await ticketDetail(db, id, user.id) };
  });

  /** Looks a ticket up by key (BEE-24) within a workspace. */
  app.get('/workspaces/:id/tickets/:key', async (req) => {
    const user = requireUser(req);
    const { id, key } = parse(z.object({ id: z.uuid(), key: z.string().max(30) }), req.params);
    const k = parseTicketKey(key);
    if (!k) throw notFound('Ticket not found');
    const [p] = await db
      .select()
      .from(projects)
      .where(and(eq(projects.workspaceId, id), eq(projects.key, k.key)));
    if (!p) throw notFound('Ticket not found');
    const [t] = await db
      .select({ id: tickets.id })
      .from(tickets)
      .where(
        and(eq(tickets.projectId, p.id), eq(tickets.number, k.number), isNull(tickets.deletedAt)),
      );
    if (!t) throw notFound('Ticket not found');
    return { ticket: await ticketDetail(db, t.id, user.id) };
  });

  app.patch('/tickets/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const a = await ticketAccess(db, id, user.id);
    if (!a.canEdit) throw forbidden();
    const b = parse(ticketInput, req.body);
    const ctx = await projectContext(db, a.project);
    const row = await updateTicket(db, ctx, a.ticket, b, user.id);
    return { ticket: (await ticketDTOs(db, [row]))[0] };
  });

  /** Same change to many tickets of one project, or delete them. */
  app.post('/tickets/bulk', async (req) => {
    const user = requireUser(req);
    const b = parse(
      z.object({
        ids: z.array(z.uuid()).min(1).max(500),
        patch: ticketInput.omit({ title: true, description: true, rank: true }).optional(),
        delete: z.boolean().optional(),
      }),
      req.body,
    );
    const rows = await db
      .select()
      .from(tickets)
      .where(and(inArray(tickets.id, b.ids), isNull(tickets.deletedAt)));
    const projectIds = [...new Set(rows.map((r) => r.projectId))];
    if (projectIds.length !== 1) throw badRequest('Pick tickets of one project');
    const a = await projectAccess(db, projectIds[0]!, user.id);
    if (!a.canEdit) throw forbidden();
    if (b.delete) {
      const gone = new Set<string>();
      for (const r of rows) {
        if (gone.has(r.id)) continue;
        for (const d of await deleteTicket(db, r, user.id)) gone.add(d);
      }
      return { updated: [], deleted: [...gone], errors: [] };
    }
    if (!b.patch) throw badRequest('Provide patch or delete');
    const ctx = await projectContext(db, a.project);
    const updated = [];
    const errors: { id: string; message: string }[] = [];
    for (const r of rows) {
      try {
        updated.push(await updateTicket(db, ctx, r, b.patch, user.id));
      } catch (e) {
        errors.push({ id: r.id, message: (e as Error).message });
      }
    }
    return { updated: await ticketDTOs(db, updated), deleted: [], errors };
  });

  app.delete('/tickets/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const a = await ticketAccess(db, id, user.id);
    if (!a.canEdit) throw forbidden();
    return { deleted: await deleteTicket(db, a.ticket, user.id) };
  });

  /** Cross-project search (My tickets, saved views, MCP). */
  app.post('/tickets/search', async (req) => {
    const user = requireUser(req);
    const b = parse(
      z.object({
        workspaceId: z.uuid().optional(),
        projectIds: z.array(z.uuid()).max(100).optional(),
        filter: filterSchema,
        sortBy: z.enum(['rank', 'priority', 'dueDate', 'updatedAt', 'createdAt', 'key']).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
      }),
      req.body,
    );
    let rows = await visibleProjects(db, user.id, b.workspaceId);
    if (b.projectIds) rows = rows.filter((p) => b.projectIds!.includes(p.id));
    return { tickets: await searchTickets(db, user.id, rows, b.filter, b) };
  });

  // ---------- comments ----------

  app.post('/tickets/:id/comments', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const a = await ticketAccess(db, id, user.id);
    if (a.project.archivedAt) throw forbidden('The project is archived');
    const { body } = parse(z.object({ body: z.string().trim().min(1).max(20_000) }), req.body);
    const [c] = await db
      .insert(ticketComments)
      .values({ ticketId: id, authorId: user.id, body })
      .returning();
    await db.update(tickets).set({ updatedAt: new Date() }).where(eq(tickets.id, id));
    const members = await workspaceUsers(db, a.project.workspaceId);
    const mentions = mentioned(body, members);
    const watchers = await watcherIds(db, id);
    await watch(db, id, [user.id]);
    await notifyTicket(db, {
      project: a.project,
      ticketId: id,
      actorId: user.id,
      kind: 'ticket_mention',
      recipients: mentions,
      detail: body,
    });
    await notifyTicket(db, {
      project: a.project,
      ticketId: id,
      actorId: user.id,
      kind: 'ticket_comment',
      recipients: watchers.filter((w) => !mentions.includes(w)),
      detail: body,
    });
    const refs = await loadUserRefs(db, [user.id]);
    reply.status(201);
    return {
      comment: {
        id: c!.id,
        author: refs.get(user.id) ?? null,
        body: c!.body,
        createdAt: c!.createdAt.toISOString(),
        editedAt: null,
        mine: true,
      },
    };
  });

  const ownComment = async (id: string, userId: string) => {
    const [c] = await db.select().from(ticketComments).where(eq(ticketComments.id, id));
    if (!c) throw notFound('Comment not found');
    const a = await ticketAccess(db, c.ticketId, userId);
    return { c, a };
  };

  app.patch('/ticket-comments/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const { c } = await ownComment(id, user.id);
    if (c.authorId !== user.id) throw forbidden('Only its author can edit a comment');
    const { body } = parse(z.object({ body: z.string().trim().min(1).max(20_000) }), req.body);
    const [r] = await db
      .update(ticketComments)
      .set({ body, editedAt: new Date() })
      .where(eq(ticketComments.id, id))
      .returning();
    return { comment: { id: r!.id, body: r!.body, editedAt: r!.editedAt!.toISOString() } };
  });

  app.delete('/ticket-comments/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const { c, a } = await ownComment(id, user.id);
    if (c.authorId !== user.id && a.role !== 'owner') throw forbidden();
    await db.delete(ticketComments).where(eq(ticketComments.id, id));
    return { ok: true };
  });

  // ---------- watchers ----------

  app.put('/tickets/:id/watch', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    await ticketAccess(db, id, user.id);
    await watch(db, id, [user.id]);
    return { watching: true };
  });

  app.delete('/tickets/:id/watch', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    await ticketAccess(db, id, user.id);
    await db
      .delete(ticketWatchers)
      .where(and(eq(ticketWatchers.ticketId, id), eq(ticketWatchers.userId, user.id)));
    return { watching: false };
  });

  /** Adds or removes another member as a watcher (editors). */
  app.post('/tickets/:id/watchers', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const a = await ticketAccess(db, id, user.id);
    if (!a.canEdit) throw forbidden();
    const b = parse(z.object({ userId: z.uuid(), watching: z.boolean() }), req.body);
    const members = await workspaceUsers(db, a.project.workspaceId);
    if (!members.some((m) => m.id === b.userId)) throw badRequest('Not a member of the workspace');
    if (b.watching) await watch(db, id, [b.userId]);
    else
      await db
        .delete(ticketWatchers)
        .where(and(eq(ticketWatchers.ticketId, id), eq(ticketWatchers.userId, b.userId)));
    return { ok: true };
  });

  // ---------- links ----------

  app.post('/tickets/:id/links', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const a = await ticketAccess(db, id, user.id);
    if (!a.canEdit) throw forbidden();
    const b = parse(
      z.object({
        kind: z.enum(LINK_KINDS),
        /** out: this ticket blocks / duplicates the other; in: the other way round */
        direction: z.enum(['out', 'in']).default('out'),
        targetId: z.uuid().optional(),
        targetKey: z.string().max(30).optional(),
      }),
      req.body,
    );
    let targetId = b.targetId;
    if (!targetId && b.targetKey) {
      const k = parseTicketKey(b.targetKey);
      if (k) {
        const [hit] = await db
          .select({ id: tickets.id })
          .from(tickets)
          .innerJoin(projects, eq(projects.id, tickets.projectId))
          .where(
            and(
              eq(projects.workspaceId, a.project.workspaceId),
              eq(projects.key, k.key),
              eq(tickets.number, k.number),
              isNull(tickets.deletedAt),
            ),
          );
        targetId = hit?.id;
      }
    }
    if (!targetId) throw notFound('Ticket not found');
    if (targetId === id) throw badRequest('A ticket cannot link to itself');
    const other = await ticketAccess(db, targetId, user.id);
    if (other.project.workspaceId !== a.project.workspaceId)
      throw badRequest('Link tickets of one workspace');
    const [fromId, toId] = b.direction === 'out' ? [id, targetId] : [targetId, id];
    const [l] = await db
      .insert(ticketLinks)
      .values({ fromId, toId, kind: b.kind, createdById: user.id })
      .onConflictDoNothing()
      .returning();
    if (l) {
      const ref = (await ticketRefs(db, [targetId])).get(targetId);
      await logEvents(db, a.ticket, user.id, [
        { field: 'link', from: null, to: { kind: b.kind, direction: b.direction, key: ref?.key } },
      ]);
      await db
        .update(tickets)
        .set({ updatedAt: new Date() })
        .where(inArray(tickets.id, [id, targetId]));
    }
    reply.status(201);
    return { ok: true };
  });

  app.delete('/ticket-links/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const [l] = await db.select().from(ticketLinks).where(eq(ticketLinks.id, id));
    if (!l) throw notFound('Link not found');
    const a = await ticketAccess(db, l.fromId, user.id);
    if (!a.canEdit) throw forbidden();
    await db.delete(ticketLinks).where(eq(ticketLinks.id, id));
    await db
      .update(tickets)
      .set({ updatedAt: new Date() })
      .where(inArray(tickets.id, [l.fromId, l.toId]));
    return { ok: true };
  });

  // ---------- documents ----------

  app.post('/tickets/:id/documents', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const a = await ticketAccess(db, id, user.id);
    if (!a.canEdit) throw forbidden();
    const { documentId } = parse(z.object({ documentId: z.uuid() }), req.body);
    await docAccess(db, { userId: user.id, documentId });
    await db
      .insert(ticketDocuments)
      .values({ ticketId: id, documentId, source: 'manual' })
      .onConflictDoNothing();
    await db.update(tickets).set({ updatedAt: new Date() }).where(eq(tickets.id, id));
    reply.status(201);
    return { ok: true };
  });

  app.delete('/tickets/:id/documents/:documentId', async (req) => {
    const user = requireUser(req);
    const { id, documentId } = parse(z.object({ id: z.uuid(), documentId: z.uuid() }), req.params);
    const a = await ticketAccess(db, id, user.id);
    if (!a.canEdit) throw forbidden();
    await db
      .delete(ticketDocuments)
      .where(
        and(
          eq(ticketDocuments.ticketId, id),
          eq(ticketDocuments.documentId, documentId),
          eq(ticketDocuments.source, 'manual'),
        ),
      );
    return { ok: true };
  });

  /** Tickets a document references or is linked to, that the reader can see. */
  app.get('/documents/:id/tickets', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    await docAccess(db, { userId: user.id, documentId: id });
    const rows = await db
      .select({ ticketId: ticketDocuments.ticketId, workspaceId: projects.workspaceId })
      .from(ticketDocuments)
      .innerJoin(tickets, eq(tickets.id, ticketDocuments.ticketId))
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, projects.workspaceId),
          eq(workspaceMembers.userId, user.id),
        ),
      )
      .where(and(eq(ticketDocuments.documentId, id), isNull(tickets.deletedAt)));
    const refs = await ticketRefs(
      db,
      rows.map((r) => r.ticketId),
    );
    return { tickets: [...refs.values()] };
  });

  /** Live chips: status of tickets by id (only ones the reader can see). */
  app.post('/tickets/refs', async (req) => {
    const user = requireUser(req);
    const { ids } = parse(z.object({ ids: z.array(z.uuid()).max(200) }), req.body);
    if (!ids.length) return { tickets: [] };
    const ok = await db
      .select({ id: tickets.id })
      .from(tickets)
      .innerJoin(projects, eq(projects.id, tickets.projectId))
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, projects.workspaceId),
          eq(workspaceMembers.userId, user.id),
        ),
      )
      .where(inArray(tickets.id, ids));
    const refs = await ticketRefs(
      db,
      ok.map((r) => r.id),
    );
    return { tickets: [...refs.values()] };
  });

  /** My tickets: open tickets assigned to the caller in a workspace (or all). */
  app.get('/my-tickets', async (req) => {
    const user = requireUser(req);
    const q = parse(
      z.object({ workspaceId: z.uuid().optional(), done: z.enum(['0', '1']).optional() }),
      req.query,
    );
    const rows = await visibleProjects(db, user.id, q.workspaceId);
    const list = await searchTickets(
      db,
      user.id,
      rows.filter((p) => !p.archivedAt),
      { assignees: ['me'], ...(q.done === '1' ? {} : { categories: ['todo', 'doing'] }) },
      { sortBy: 'priority' },
    );
    return { tickets: list };
  });
}
