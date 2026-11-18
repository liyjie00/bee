/* Ticket projects and their settings: statuses, transitions, labels, custom fields, sprints,
 * saved views, and reports. Tickets themselves are in tickets.ts. */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, max, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  projectFields,
  projectLabels,
  projectStatuses,
  projectTransitions,
  projects,
  savedViews,
  sprints,
  tickets,
  type Db,
} from '@bee/db';
import {
  FIELD_KINDS,
  GROUP_BYS,
  PRIORITIES,
  PROJECT_KEY_RE,
  PROJECT_TEMPLATES,
  SORT_BYS,
  STATUS_CATEGORIES,
  SWIMLANES,
  TEMPLATE_STATUSES,
  TICKET_TYPES,
  VIEW_KINDS,
  type SavedViewDTO,
  type WorkspaceRole,
} from '@bee/shared';
import { requireMember } from '../lib/access.js';
import { langOf } from '../lib/delivery.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import {
  fieldDTO,
  logEvents,
  projectAccess,
  projectDTOs,
  sprintBurndown,
  sprintDTO,
  sprintTotals,
  statusDTO,
  workspaceUsers,
  type ProjectRow,
} from '../lib/tickets.js';
import { loadUserRefs } from '../lib/dto.js';
import { exportTickets, parseCsv, readImport } from '../lib/ticket-csv.js';
import { createTicket, projectContext } from '../lib/ticket-ops.js';
import { idParams, parse } from '../lib/validate.js';
import { requireUser } from './auth.js';

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const name = z.string().trim().min(1).max(120);

const projectBody = z.object({
  name,
  key: z
    .string()
    .trim()
    .toUpperCase()
    .regex(PROJECT_KEY_RE, 'Key: 2–10 letters or digits, starting with a letter'),
  color: color.optional(),
  description: z.string().max(4000).optional(),
  template: z.enum(PROJECT_TEMPLATES).default('scrum'),
});

const projectPatch = z.object({
  name: name.optional(),
  key: z.string().trim().toUpperCase().regex(PROJECT_KEY_RE).optional(),
  color: color.optional(),
  description: z.string().max(4000).optional(),
  leadId: z.uuid().nullable().optional(),
  usesSprints: z.boolean().optional(),
  restrictTransitions: z.boolean().optional(),
  archived: z.boolean().optional(),
});

const statusBody = z.object({
  name: z.string().trim().min(1).max(60),
  color: color.optional(),
  category: z.enum(STATUS_CATEGORIES),
  wipLimit: z.number().int().min(1).max(999).nullable().optional(),
  requireResolution: z.boolean().optional(),
});

const fieldOption = z.object({
  id: z.string().min(1).max(40).optional(),
  label: z.string().trim().min(1).max(80),
  color: color.optional(),
});
const fieldBody = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(FIELD_KINDS),
  options: z.array(fieldOption).max(100).optional(),
  appliesTo: z.array(z.enum(TICKET_TYPES)).min(1).nullable().optional(),
});

const sprintBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  goal: z.string().max(1000).optional(),
  startDate: date.nullable().optional(),
  endDate: date.nullable().optional(),
  capacity: z.number().int().min(0).max(100000).nullable().optional(),
});

const filterSchema = z.object({
  q: z.string().max(200).optional(),
  types: z.array(z.enum(TICKET_TYPES)).optional(),
  statusIds: z.array(z.uuid()).optional(),
  categories: z.array(z.enum(STATUS_CATEGORIES)).optional(),
  assignees: z.array(z.string().max(40)).optional(),
  priorities: z.array(z.enum(PRIORITIES)).optional(),
  labelIds: z.array(z.uuid()).optional(),
  sprint: z.string().max(40).optional(),
  epicId: z.uuid().optional(),
  due: z.enum(['overdue', 'week', 'none']).optional(),
  fields: z.record(z.string(), z.union([z.string().max(200), z.boolean()])).optional(),
});
const viewConfig = z.object({
  view: z.enum(VIEW_KINDS),
  filter: filterSchema,
  groupBy: z.enum(GROUP_BYS).optional(),
  swimlane: z.enum(SWIMLANES).optional(),
  sortBy: z.enum(SORT_BYS).optional(),
});

const statusParams = z.object({ id: z.uuid(), statusId: z.uuid() });
const labelParams = z.object({ id: z.uuid(), labelId: z.uuid() });
const fieldParams = z.object({ id: z.uuid(), fieldId: z.uuid() });

async function nextPosition(
  db: Db,
  table: typeof projectStatuses | typeof projectFields,
  projectId: string,
) {
  const [r] = await db
    .select({ m: max(table.position) })
    .from(table)
    .where(eq(table.projectId, projectId));
  return (r?.m ?? 0) + 1;
}

async function requireAdmin(db: Db, projectId: string, userId: string) {
  const a = await projectAccess(db, projectId, userId);
  if (!a.canAdmin)
    throw forbidden('Only the project lead or a workspace owner can change settings');
  return a;
}

export async function projectRoutes(app: FastifyInstance) {
  const { db } = app;

  const dtoFor = async (p: ProjectRow, userId: string, role: WorkspaceRole) =>
    (await projectDTOs(db, [p], userId, new Map([[p.workspaceId, role]])))[0]!;

  app.get('/workspaces/:id/projects', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const role = await requireMember(db, id, user.id);
    const rows = await db
      .select()
      .from(projects)
      .where(eq(projects.workspaceId, id))
      .orderBy(asc(projects.name));
    return { projects: await projectDTOs(db, rows, user.id, new Map([[id, role]])) };
  });

  app.post('/workspaces/:id/projects', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const role = await requireMember(db, id, user.id);
    if (role === 'viewer') throw forbidden();
    const b = parse(projectBody, req.body);
    const [dup] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.workspaceId, id), eq(projects.key, b.key)));
    if (dup) throw conflict(`Key ${b.key} is already used`, 'key_taken');
    const zh = langOf(user.prefs) === 'zh-CN';
    const project = await db.transaction(async (tx) => {
      const [p] = await tx
        .insert(projects)
        .values({
          workspaceId: id,
          name: b.name,
          key: b.key,
          color: b.color ?? '#e8a317',
          description: b.description ?? '',
          template: b.template,
          usesSprints: b.template === 'scrum',
          leadId: user.id,
          createdById: user.id,
        })
        .returning();
      await tx.insert(projectStatuses).values(
        TEMPLATE_STATUSES[b.template].map((s, i) => ({
          projectId: p!.id,
          name: zh ? s.zh : s.en,
          color: s.color,
          category: s.category,
          position: i + 1,
        })),
      );
      if (b.template === 'scrum') {
        await tx.insert(sprints).values({ projectId: p!.id, name: `${b.key} Sprint 1` });
      }
      return p!;
    });
    reply.status(201);
    return { project: await dtoFor(project, user.id, role) };
  });

  app.get('/projects/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const a = await projectAccess(db, id, user.id);
    const [members, sprintRows] = await Promise.all([
      workspaceUsers(db, a.project.workspaceId),
      db.select().from(sprints).where(eq(sprints.projectId, id)).orderBy(asc(sprints.createdAt)),
    ]);
    return {
      project: await dtoFor(a.project, user.id, a.role),
      members: members.map((m) => ({
        id: m.id,
        name: m.name,
        avatarUrl: m.avatarUrl,
        color: m.color,
        role: m.role,
      })),
      sprints: sprintRows.map(sprintDTO),
    };
  });

  app.patch('/projects/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const a = await requireAdmin(db, id, user.id);
    const b = parse(projectPatch, req.body);
    if (b.key && b.key !== a.project.key) {
      const [dup] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.workspaceId, a.project.workspaceId), eq(projects.key, b.key)));
      if (dup) throw conflict(`Key ${b.key} is already used`, 'key_taken');
    }
    if (b.leadId) {
      const members = await workspaceUsers(db, a.project.workspaceId);
      if (!members.some((m) => m.id === b.leadId)) throw badRequest('Lead must be a member');
    }
    const { archived, ...rest } = b;
    const [p] = await db
      .update(projects)
      .set({
        ...rest,
        ...(archived === undefined ? {} : { archivedAt: archived ? new Date() : null }),
      })
      .where(eq(projects.id, id))
      .returning();
    return { project: await dtoFor(p!, user.id, a.role) };
  });

  /** Deletes the project and all its tickets. Workspace owners only. */
  app.delete('/projects/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const a = await projectAccess(db, id, user.id);
    if (a.role !== 'owner') throw forbidden('Only workspace owners can delete projects');
    await db.delete(projects).where(eq(projects.id, id));
    return { ok: true };
  });

  // ---------- statuses ----------

  app.post('/projects/:id/statuses', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    await requireAdmin(db, id, user.id);
    const b = parse(statusBody, req.body);
    const [s] = await db
      .insert(projectStatuses)
      .values({
        projectId: id,
        name: b.name,
        color: b.color ?? '#7b8375',
        category: b.category,
        wipLimit: b.wipLimit ?? null,
        requireResolution: b.requireResolution ?? false,
        position: await nextPosition(db, projectStatuses, id),
      })
      .returning();
    reply.status(201);
    return { status: statusDTO(s!) };
  });

  app.patch('/projects/:id/statuses/:statusId', async (req) => {
    const user = requireUser(req);
    const { id, statusId } = parse(statusParams, req.params);
    await requireAdmin(db, id, user.id);
    const b = parse(statusBody.partial(), req.body);
    const [s] = await db
      .update(projectStatuses)
      .set(b)
      .where(and(eq(projectStatuses.id, statusId), eq(projectStatuses.projectId, id)))
      .returning();
    if (!s) throw notFound('Status not found');
    return { status: statusDTO(s) };
  });

  /** Removes a status; its tickets move to `moveTo`. */
  app.delete('/projects/:id/statuses/:statusId', async (req) => {
    const user = requireUser(req);
    const { id, statusId } = parse(statusParams, req.params);
    await requireAdmin(db, id, user.id);
    const { moveTo } = parse(z.object({ moveTo: z.uuid() }), req.query);
    if (moveTo === statusId) throw badRequest('Pick another status');
    const rows = await db.select().from(projectStatuses).where(eq(projectStatuses.projectId, id));
    const target = rows.find((s) => s.id === moveTo);
    if (!rows.some((s) => s.id === statusId) || !target) throw notFound('Status not found');
    await db.transaction(async (tx) => {
      const moved = await tx
        .update(tickets)
        .set({ statusId: moveTo, updatedAt: new Date() })
        .where(eq(tickets.statusId, statusId))
        .returning({ id: tickets.id, projectId: tickets.projectId });
      for (const t of moved)
        await logEvents(tx as unknown as Db, t, user.id, [
          { field: 'status', from: statusId, to: moveTo },
        ]);
      await tx.delete(projectStatuses).where(eq(projectStatuses.id, statusId));
    });
    return { ok: true };
  });

  app.put('/projects/:id/status-order', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    await requireAdmin(db, id, user.id);
    const { ids } = parse(z.object({ ids: z.array(z.uuid()).min(1).max(50) }), req.body);
    const rows = await db
      .select({ id: projectStatuses.id })
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, id));
    const all = new Set(rows.map((r) => r.id));
    if (ids.length !== all.size || ids.some((x) => !all.has(x)))
      throw badRequest('List every status once');
    await db.transaction(async (tx) => {
      for (const [i, sid] of ids.entries())
        await tx
          .update(projectStatuses)
          .set({ position: i + 1 })
          .where(eq(projectStatuses.id, sid));
    });
    return { ok: true };
  });

  app.put('/projects/:id/transitions', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    await requireAdmin(db, id, user.id);
    const b = parse(
      z.object({
        transitions: z.array(z.object({ fromId: z.uuid(), toId: z.uuid() })).max(2500),
      }),
      req.body,
    );
    const rows = await db
      .select({ id: projectStatuses.id })
      .from(projectStatuses)
      .where(eq(projectStatuses.projectId, id));
    const all = new Set(rows.map((r) => r.id));
    const list = b.transitions.filter((t) => t.fromId !== t.toId);
    if (list.some((t) => !all.has(t.fromId) || !all.has(t.toId)))
      throw badRequest('Unknown status');
    await db.transaction(async (tx) => {
      await tx.delete(projectTransitions).where(eq(projectTransitions.projectId, id));
      if (list.length)
        await tx
          .insert(projectTransitions)
          .values(list.map((t) => ({ projectId: id, ...t })))
          .onConflictDoNothing();
    });
    return { ok: true };
  });

  // ---------- labels ----------

  app.post('/projects/:id/labels', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const a = await projectAccess(db, id, user.id);
    if (!a.canEdit) throw forbidden();
    const b = parse(
      z.object({ name: z.string().trim().min(1).max(60), color: color.optional() }),
      req.body,
    );
    const [existing] = await db
      .select()
      .from(projectLabels)
      .where(
        and(eq(projectLabels.projectId, id), sql`lower(${projectLabels.name}) = lower(${b.name})`),
      );
    if (existing) return { label: { id: existing.id, name: existing.name, color: existing.color } };
    const [l] = await db
      .insert(projectLabels)
      .values({ projectId: id, name: b.name, color: b.color ?? '#3b7dd8' })
      .returning();
    reply.status(201);
    return { label: { id: l!.id, name: l!.name, color: l!.color } };
  });

  app.patch('/projects/:id/labels/:labelId', async (req) => {
    const user = requireUser(req);
    const { id, labelId } = parse(labelParams, req.params);
    await requireAdmin(db, id, user.id);
    const b = parse(
      z.object({ name: z.string().trim().min(1).max(60).optional(), color: color.optional() }),
      req.body,
    );
    const [l] = await db
      .update(projectLabels)
      .set(b)
      .where(and(eq(projectLabels.id, labelId), eq(projectLabels.projectId, id)))
      .returning();
    if (!l) throw notFound('Label not found');
    return { label: { id: l.id, name: l.name, color: l.color } };
  });

  app.delete('/projects/:id/labels/:labelId', async (req) => {
    const user = requireUser(req);
    const { id, labelId } = parse(labelParams, req.params);
    await requireAdmin(db, id, user.id);
    await db.transaction(async (tx) => {
      await tx
        .update(tickets)
        .set({ labelIds: sql`${tickets.labelIds} - ${labelId}::text` })
        .where(and(eq(tickets.projectId, id), sql`${tickets.labelIds} ? ${labelId}::text`));
      await tx
        .delete(projectLabels)
        .where(and(eq(projectLabels.id, labelId), eq(projectLabels.projectId, id)));
    });
    return { ok: true };
  });

  // ---------- custom fields ----------

  const withOptionIds = (opts: z.infer<typeof fieldOption>[] | undefined) =>
    (opts ?? []).map((o, i) => ({
      id: o.id ?? randomUUID().slice(0, 8),
      label: o.label,
      color: o.color ?? ['#3b7dd8', '#1e6b2a', '#c2410c', '#7c3aed', '#e8a317', '#0e7490'][i % 6]!,
    }));

  app.post('/projects/:id/fields', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    await requireAdmin(db, id, user.id);
    const b = parse(fieldBody, req.body);
    const [f] = await db
      .insert(projectFields)
      .values({
        projectId: id,
        name: b.name,
        kind: b.kind,
        options: withOptionIds(b.options),
        appliesTo: b.appliesTo ?? null,
        position: await nextPosition(db, projectFields, id),
      })
      .returning();
    reply.status(201);
    return { field: fieldDTO(f!) };
  });

  app.patch('/projects/:id/fields/:fieldId', async (req) => {
    const user = requireUser(req);
    const { id, fieldId } = parse(fieldParams, req.params);
    await requireAdmin(db, id, user.id);
    const b = parse(
      fieldBody.omit({ kind: true }).partial().extend({ position: z.number().optional() }),
      req.body,
    );
    const [f] = await db
      .update(projectFields)
      .set({
        ...(b.name ? { name: b.name } : {}),
        ...(b.options ? { options: withOptionIds(b.options) } : {}),
        ...(b.appliesTo !== undefined ? { appliesTo: b.appliesTo } : {}),
        ...(b.position !== undefined ? { position: b.position } : {}),
      })
      .where(and(eq(projectFields.id, fieldId), eq(projectFields.projectId, id)))
      .returning();
    if (!f) throw notFound('Field not found');
    return { field: fieldDTO(f) };
  });

  app.delete('/projects/:id/fields/:fieldId', async (req) => {
    const user = requireUser(req);
    const { id, fieldId } = parse(fieldParams, req.params);
    await requireAdmin(db, id, user.id);
    await db.transaction(async (tx) => {
      await tx
        .update(tickets)
        .set({ fields: sql`${tickets.fields} - ${fieldId}::text` })
        .where(and(eq(tickets.projectId, id), sql`${tickets.fields} ? ${fieldId}::text`));
      await tx
        .delete(projectFields)
        .where(and(eq(projectFields.id, fieldId), eq(projectFields.projectId, id)));
    });
    return { ok: true };
  });

  // ---------- sprints ----------

  const loadSprint = async (sprintId: string, userId: string) => {
    const [s] = await db.select().from(sprints).where(eq(sprints.id, sprintId)).limit(1);
    if (!s) throw notFound('Sprint not found');
    const a = await projectAccess(db, s.projectId, userId);
    return { sprint: s, ...a };
  };

  app.get('/projects/:id/sprints', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    await projectAccess(db, id, user.id);
    const rows = await db
      .select()
      .from(sprints)
      .where(eq(sprints.projectId, id))
      .orderBy(asc(sprints.createdAt));
    return { sprints: rows.map(sprintDTO) };
  });

  app.post('/projects/:id/sprints', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const a = await projectAccess(db, id, user.id);
    if (!a.canEdit) throw forbidden();
    const b = parse(sprintBody, req.body);
    const [{ n }] = (await db
      .select({ n: sql<number>`count(*)::int` })
      .from(sprints)
      .where(eq(sprints.projectId, id))) as [{ n: number }];
    const [s] = await db
      .insert(sprints)
      .values({
        projectId: id,
        name: b.name ?? `${a.project.key} Sprint ${n + 1}`,
        goal: b.goal ?? '',
        startDate: b.startDate ?? null,
        endDate: b.endDate ?? null,
        capacity: b.capacity ?? null,
      })
      .returning();
    reply.status(201);
    return { sprint: sprintDTO(s!) };
  });

  app.patch('/sprints/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const a = await loadSprint(id, user.id);
    if (!a.canEdit) throw forbidden();
    const b = parse(sprintBody, req.body);
    const [s] = await db.update(sprints).set(b).where(eq(sprints.id, id)).returning();
    return { sprint: sprintDTO(s!) };
  });

  app.post('/sprints/:id/start', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const a = await loadSprint(id, user.id);
    if (!a.canEdit) throw forbidden();
    if (a.sprint.state !== 'planned') throw badRequest('Only a planned sprint can start');
    const b = parse(
      z.object({
        startDate: date.optional(),
        endDate: date.optional(),
        goal: z.string().max(1000).optional(),
      }),
      req.body,
    );
    const [active] = await db
      .select({ id: sprints.id })
      .from(sprints)
      .where(and(eq(sprints.projectId, a.sprint.projectId), eq(sprints.state, 'active')));
    if (active) throw conflict('Complete the active sprint first', 'sprint_active');
    const today = new Date().toISOString().slice(0, 10);
    const start = b.startDate ?? a.sprint.startDate ?? today;
    const end =
      b.endDate ??
      a.sprint.endDate ??
      new Date(Date.parse(start + 'T00:00:00Z') + 13 * 86400_000).toISOString().slice(0, 10);
    if (end < start) throw badRequest('The end date is before the start date');
    const totals = await sprintTotals(db, id);
    const [s] = await db
      .update(sprints)
      .set({
        state: 'active',
        startDate: start,
        endDate: end,
        startedAt: new Date(),
        ...(b.goal !== undefined ? { goal: b.goal } : {}),
        summary: {
          committedPoints: totals.points,
          completedPoints: 0,
          completedCount: 0,
          incompleteCount: totals.count,
        },
      })
      .where(eq(sprints.id, id))
      .returning();
    return { sprint: sprintDTO(s!) };
  });

  /** Closes the active sprint; unfinished tickets go to another sprint or the backlog. */
  app.post('/sprints/:id/complete', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const a = await loadSprint(id, user.id);
    if (!a.canEdit) throw forbidden();
    if (a.sprint.state !== 'active') throw badRequest('Only the active sprint can be completed');
    const b = parse(
      z.object({
        moveTo: z.union([z.uuid(), z.literal('backlog'), z.literal('new')]).default('backlog'),
      }),
      req.body,
    );
    let target: string | null = null;
    if (b.moveTo === 'new') {
      const [n] = await db
        .insert(sprints)
        .values({
          projectId: a.sprint.projectId,
          name: `${a.project.key} Sprint ${(await db.select({ id: sprints.id }).from(sprints).where(eq(sprints.projectId, a.sprint.projectId))).length + 1}`,
        })
        .returning();
      target = n!.id;
    } else if (b.moveTo !== 'backlog') {
      const [t] = await db
        .select()
        .from(sprints)
        .where(and(eq(sprints.id, b.moveTo), eq(sprints.projectId, a.sprint.projectId)));
      if (!t || t.state !== 'planned') throw badRequest('Move to a planned sprint');
      target = t.id;
    }
    const totals = await sprintTotals(db, id);
    const open = await db
      .select({ id: tickets.id, projectId: tickets.projectId })
      .from(tickets)
      .innerJoin(projectStatuses, eq(projectStatuses.id, tickets.statusId))
      .where(
        and(
          eq(tickets.sprintId, id),
          isNull(tickets.deletedAt),
          ne(projectStatuses.category, 'done'),
        ),
      );
    const [s] = await db.transaction(async (tx) => {
      if (open.length) {
        const ids = open.map((t) => t.id);
        await tx
          .update(tickets)
          .set({ sprintId: target, updatedAt: new Date() })
          .where(or(inArray(tickets.id, ids), inArray(tickets.parentId, ids)));
        for (const t of open)
          await logEvents(tx as unknown as Db, t, user.id, [
            { field: 'sprint', from: id, to: target },
          ]);
      }
      return tx
        .update(sprints)
        .set({
          state: 'closed',
          completedAt: new Date(),
          summary: {
            committedPoints: a.sprint.summary?.committedPoints ?? totals.points,
            completedPoints: totals.donePoints,
            completedCount: totals.done,
            incompleteCount: open.length,
          },
        })
        .where(eq(sprints.id, id))
        .returning();
    });
    return { sprint: sprintDTO(s!), moved: open.length, movedTo: target };
  });

  /** Deletes a planned sprint; its tickets go back to the backlog. */
  app.delete('/sprints/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const a = await loadSprint(id, user.id);
    if (!a.canEdit) throw forbidden();
    if (a.sprint.state === 'active') throw badRequest('Complete the sprint instead');
    await db.delete(sprints).where(eq(sprints.id, id));
    return { ok: true };
  });

  app.get('/sprints/:id/burndown', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const a = await loadSprint(id, user.id);
    const r = await sprintBurndown(db, a.sprint);
    return {
      sprint: sprintDTO(a.sprint),
      days: r.days,
      remaining: r.remaining,
      scope: r.scope,
      added: r.added,
    };
  });

  app.get('/projects/:id/velocity', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    await projectAccess(db, id, user.id);
    const rows = await db
      .select()
      .from(sprints)
      .where(and(eq(sprints.projectId, id), eq(sprints.state, 'closed')))
      .orderBy(desc(sprints.completedAt))
      .limit(8);
    const list = rows.reverse().map((s) => ({
      id: s.id,
      name: s.name,
      committed: s.summary?.committedPoints ?? 0,
      completed: s.summary?.completedPoints ?? 0,
    }));
    const average = list.length
      ? Math.round((list.reduce((x, s) => x + s.completed, 0) / list.length) * 10) / 10
      : 0;
    return { sprints: list, average };
  });

  /** Points per assignee by status category (whole project, or one sprint). */
  app.get('/projects/:id/workload', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    await projectAccess(db, id, user.id);
    const q = parse(z.object({ sprintId: z.uuid().optional() }), req.query);
    const rows = await db
      .select({
        assigneeId: tickets.assigneeId,
        category: projectStatuses.category,
        points: sql<number>`coalesce(sum(${tickets.storyPoints}), 0)::float`,
        n: sql<number>`count(*)::int`,
      })
      .from(tickets)
      .innerJoin(projectStatuses, eq(projectStatuses.id, tickets.statusId))
      .where(
        and(
          eq(tickets.projectId, id),
          isNull(tickets.deletedAt),
          ne(tickets.type, 'epic'),
          q.sprintId ? eq(tickets.sprintId, q.sprintId) : undefined,
        ),
      )
      .groupBy(tickets.assigneeId, projectStatuses.category);
    const refs = await loadUserRefs(
      db,
      rows.map((r) => r.assigneeId),
    );
    const by = new Map<
      string,
      {
        user: ReturnType<typeof refs.get> | null;
        todo: number;
        doing: number;
        done: number;
        count: number;
      }
    >();
    for (const r of rows) {
      const k = r.assigneeId ?? '';
      const e = by.get(k) ?? {
        user: r.assigneeId ? (refs.get(r.assigneeId) ?? null) : null,
        todo: 0,
        doing: 0,
        done: 0,
        count: 0,
      };
      e[r.category] += Number(r.points);
      e.count += Number(r.n);
      by.set(k, e);
    }
    return {
      rows: [...by.values()].sort(
        (x, y) => y.todo + y.doing + y.done - (x.todo + x.doing + x.done),
      ),
    };
  });

  // ---------- CSV ----------

  app.get('/projects/:id/export.csv', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const a = await projectAccess(db, id, user.id);
    const ctx = await projectContext(db, a.project);
    const [rows, members, labels] = await Promise.all([
      db
        .select()
        .from(tickets)
        .where(and(eq(tickets.projectId, id), isNull(tickets.deletedAt)))
        .orderBy(asc(tickets.number)),
      workspaceUsers(db, a.project.workspaceId),
      db.select().from(projectLabels).where(eq(projectLabels.projectId, id)),
    ]);
    const people = new Map(members.map((m) => [m.id, { name: m.name, email: m.email }]));
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${a.project.key}-tickets.csv"`)
      .send(exportTickets(ctx, rows, people, labels));
  });

  /** Imports tickets from CSV text (Bee's export or a Jira "Export CSV (all fields)"). */
  app.post('/projects/:id/import', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const a = await projectAccess(db, id, user.id);
    if (!a.canEdit) throw forbidden();
    const { csv } = parse(z.object({ csv: z.string().min(1).max(8_000_000) }), req.body);
    const table = parseCsv(csv);
    if (table.length > 5001) throw badRequest('At most 5000 tickets per import');
    let ctx = await projectContext(db, a.project);
    const members = await workspaceUsers(db, a.project.workspaceId);
    const { rows, errors } = readImport(table, ctx, members);
    // Labels and sprints named in the file are created when missing.
    const labelNames = [...new Set(rows.flatMap((r) => r.labels))];
    const existing = await db.select().from(projectLabels).where(eq(projectLabels.projectId, id));
    const labelId = new Map(existing.map((l) => [l.name.toLowerCase(), l.id]));
    const colors = ['#3b7dd8', '#1e6b2a', '#c2410c', '#7c3aed', '#e8a317', '#0e7490', '#be185d'];
    for (const name of labelNames)
      if (!labelId.has(name.toLowerCase())) {
        const [l] = await db
          .insert(projectLabels)
          .values({ projectId: id, name, color: colors[labelId.size % colors.length]! })
          .returning();
        labelId.set(name.toLowerCase(), l!.id);
      }
    const sprintId = new Map(
      [...ctx.sprints.values()]
        .filter((s) => s.state !== 'closed')
        .map((s) => [s.name.toLowerCase(), s.id]),
    );
    if (a.project.usesSprints)
      for (const name of new Set(rows.map((r) => r.sprintName).filter((x): x is string => !!x)))
        if (!sprintId.has(name.toLowerCase())) {
          const [s] = await db.insert(sprints).values({ projectId: id, name }).returning();
          sprintId.set(name.toLowerCase(), s!.id);
        }
    ctx = await projectContext(db, a.project);
    // Parents first: epics, then stories / tasks / bugs, then subtasks.
    const order = { epic: 0, story: 1, task: 1, bug: 1, subtask: 2 } as const;
    const sorted = [...rows].sort((x, y) => order[x.type] - order[y.type]);
    const byKey = new Map<string, string>();
    const byTitle = new Map<string, string>();
    const keyRows = await db
      .select({ id: tickets.id, number: tickets.number, title: tickets.title })
      .from(tickets)
      .where(and(eq(tickets.projectId, id), isNull(tickets.deletedAt)));
    for (const t of keyRows) {
      byKey.set(`${a.project.key}-${t.number}`.toLowerCase(), t.id);
      byTitle.set(t.title.toLowerCase(), t.id);
    }
    let created = 0;
    for (const r of sorted) {
      const parentId = r.parentKey
        ? (byKey.get(r.parentKey.toLowerCase()) ?? byTitle.get(r.parentKey.toLowerCase()) ?? null)
        : null;
      const base = {
        type: r.type,
        title: r.title,
        description: r.description,
        statusId: r.statusId,
        priority: r.priority,
        assigneeId: r.assigneeId,
        reporterId: r.reporterId ?? user.id,
        sprintId: r.sprintName ? (sprintId.get(r.sprintName.toLowerCase()) ?? null) : null,
        storyPoints: r.storyPoints,
        estimateMinutes: r.estimateMinutes,
        spentMinutes: r.spentMinutes,
        startDate: r.startDate,
        dueDate: r.dueDate && r.startDate && r.dueDate < r.startDate ? r.startDate : r.dueDate,
        labelIds: r.labels.map((n) => labelId.get(n.toLowerCase())!).filter(Boolean),
      };
      try {
        let t;
        try {
          t = await createTicket(db, ctx, { ...base, parentId }, user.id);
        } catch (e) {
          if (!parentId && r.type !== 'subtask') throw e;
          // A parent that does not fit (or a subtask without one): import it as a task on its own.
          t = await createTicket(
            db,
            ctx,
            { ...base, type: r.type === 'subtask' ? 'task' : r.type, parentId: null },
            user.id,
          );
          errors.push(
            `Line ${r.line}: parent “${r.parentKey ?? ''}” not usable, imported without it`,
          );
        }
        created++;
        if (r.key) byKey.set(r.key.toLowerCase(), t.id);
        byTitle.set(r.title.toLowerCase(), t.id);
      } catch (e) {
        errors.push(`Line ${r.line}: ${(e as Error).message}`);
      }
    }
    return { created, errors: errors.slice(0, 50), errorCount: errors.length };
  });

  // ---------- saved views ----------

  const viewDTO = (v: typeof savedViews.$inferSelect, userId: string): SavedViewDTO => ({
    id: v.id,
    workspaceId: v.workspaceId,
    projectId: v.projectId,
    name: v.name,
    config: v.config,
    shared: v.shared,
    mine: v.ownerId === userId,
  });

  app.get('/workspaces/:id/views', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    await requireMember(db, id, user.id);
    const rows = await db
      .select()
      .from(savedViews)
      .where(
        and(
          eq(savedViews.workspaceId, id),
          or(eq(savedViews.ownerId, user.id), eq(savedViews.shared, true)),
        ),
      )
      .orderBy(asc(savedViews.name));
    return { views: rows.map((v) => viewDTO(v, user.id)) };
  });

  app.post('/workspaces/:id/views', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    await requireMember(db, id, user.id);
    const b = parse(
      z.object({
        name: z.string().trim().min(1).max(80),
        projectId: z.uuid().nullable().optional(),
        config: viewConfig,
        shared: z.boolean().optional(),
      }),
      req.body,
    );
    if (b.projectId) {
      const a = await projectAccess(db, b.projectId, user.id);
      if (a.project.workspaceId !== id) throw badRequest('Project is in another workspace');
    }
    const [v] = await db
      .insert(savedViews)
      .values({
        workspaceId: id,
        projectId: b.projectId ?? null,
        ownerId: user.id,
        name: b.name,
        config: b.config,
        shared: b.shared ?? false,
      })
      .returning();
    reply.status(201);
    return { view: viewDTO(v!, user.id) };
  });

  const ownView = async (id: string, userId: string) => {
    const [v] = await db.select().from(savedViews).where(eq(savedViews.id, id));
    if (!v || (v.ownerId !== userId && !v.shared)) throw notFound('View not found');
    if (v.ownerId !== userId) throw forbidden('Only its owner can change a view');
    return v;
  };

  app.patch('/views/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    await ownView(id, user.id);
    const b = parse(
      z.object({
        name: z.string().trim().min(1).max(80).optional(),
        config: viewConfig.optional(),
        shared: z.boolean().optional(),
      }),
      req.body,
    );
    const [v] = await db.update(savedViews).set(b).where(eq(savedViews.id, id)).returning();
    return { view: viewDTO(v!, user.id) };
  });

  app.delete('/views/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    await ownView(id, user.id);
    await db.delete(savedViews).where(eq(savedViews.id, id));
    return { ok: true };
  });
}
