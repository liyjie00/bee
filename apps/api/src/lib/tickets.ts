/* Ticket projects: access checks, DTOs, change history, notifications and sprint reports. */
import { and, asc, count, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  projectFields,
  projectLabels,
  projectStatuses,
  projectTransitions,
  projects,
  sprints,
  ticketComments,
  ticketEvents,
  ticketLinks,
  ticketWatchers,
  tickets,
  users,
  workspaceMembers,
  type Db,
} from '@bee/db';
import {
  ticketKey,
  workspaceRoleAtLeast,
  type FieldDTO,
  type FieldValue,
  type NotificationKind,
  type ProjectDTO,
  type SprintDTO,
  type StatusCategory,
  type StatusDTO,
  type TicketDTO,
  type TicketRefDTO,
  type UserRef,
  type WorkspaceRole,
} from '@bee/shared';
import { membershipRole } from './access.js';
import { insertNotifications } from './delivery.js';
import { loadUserRefs } from './dto.js';
import { badRequest, notFound, unauthorized } from './errors.js';

export type ProjectRow = typeof projects.$inferSelect;
export type TicketRow = typeof tickets.$inferSelect;
export type StatusRow = typeof projectStatuses.$inferSelect;
export type SprintRow = typeof sprints.$inferSelect;
export type FieldRow = typeof projectFields.$inferSelect;

export interface ProjectAccess {
  project: ProjectRow;
  role: WorkspaceRole;
  canEdit: boolean;
  canAdmin: boolean;
}

/** Workspace members see a project; editors and owners change tickets; owners and the lead change settings. */
export async function projectAccess(
  db: Db,
  projectId: string,
  userId: string | null,
): Promise<ProjectAccess> {
  if (!userId) throw unauthorized();
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  if (!project) throw notFound('Project not found');
  const role = await membershipRole(db, project.workspaceId, userId);
  if (!role) throw notFound('Project not found');
  const canEdit = workspaceRoleAtLeast(role, 'editor') && !project.archivedAt;
  const canAdmin =
    role === 'owner' || (project.leadId === userId && workspaceRoleAtLeast(role, 'editor'));
  return { project, role, canEdit, canAdmin };
}

export async function ticketAccess(db: Db, ticketId: string, userId: string | null) {
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId)).limit(1);
  if (!ticket || ticket.deletedAt) throw notFound('Ticket not found');
  const access = await projectAccess(db, ticket.projectId, userId);
  return { ticket, ...access };
}

export const statusDTO = (s: StatusRow): StatusDTO => ({
  id: s.id,
  name: s.name,
  color: s.color,
  category: s.category,
  position: s.position,
  wipLimit: s.wipLimit,
  requireResolution: s.requireResolution,
});

export const fieldDTO = (f: FieldRow): FieldDTO => ({
  id: f.id,
  name: f.name,
  kind: f.kind,
  options: f.options,
  appliesTo: f.appliesTo ?? null,
  position: f.position,
});

export const sprintDTO = (s: SprintRow): SprintDTO => ({
  id: s.id,
  projectId: s.projectId,
  name: s.name,
  goal: s.goal,
  startDate: s.startDate,
  endDate: s.endDate,
  state: s.state,
  capacity: s.capacity,
  completedAt: s.completedAt?.toISOString() ?? null,
  summary: s.summary ?? null,
});

export async function projectStatusRows(db: Db, projectId: string): Promise<StatusRow[]> {
  return db
    .select()
    .from(projectStatuses)
    .where(eq(projectStatuses.projectId, projectId))
    .orderBy(asc(projectStatuses.position));
}

export async function projectDTOs(
  db: Db,
  rows: ProjectRow[],
  userId: string,
  roles: Map<string, WorkspaceRole>,
): Promise<ProjectDTO[]> {
  if (!rows.length) return [];
  const ids = rows.map((p) => p.id);
  const [statuses, transitions, labels, fields, open, refs] = await Promise.all([
    db
      .select()
      .from(projectStatuses)
      .where(inArray(projectStatuses.projectId, ids))
      .orderBy(asc(projectStatuses.position)),
    db.select().from(projectTransitions).where(inArray(projectTransitions.projectId, ids)),
    db
      .select()
      .from(projectLabels)
      .where(inArray(projectLabels.projectId, ids))
      .orderBy(asc(projectLabels.name)),
    db
      .select()
      .from(projectFields)
      .where(inArray(projectFields.projectId, ids))
      .orderBy(asc(projectFields.position)),
    db
      .select({ projectId: tickets.projectId, n: count() })
      .from(tickets)
      .innerJoin(projectStatuses, eq(projectStatuses.id, tickets.statusId))
      .where(
        and(
          inArray(tickets.projectId, ids),
          isNull(tickets.deletedAt),
          sql`${projectStatuses.category} <> 'done'`,
        ),
      )
      .groupBy(tickets.projectId),
    loadUserRefs(
      db,
      rows.map((p) => p.leadId),
    ),
  ]);
  const openBy = new Map(open.map((o) => [o.projectId, Number(o.n)]));
  return rows.map((p) => {
    const role = roles.get(p.workspaceId) ?? 'viewer';
    return {
      id: p.id,
      workspaceId: p.workspaceId,
      name: p.name,
      key: p.key,
      color: p.color,
      description: p.description,
      template: p.template,
      lead: p.leadId ? (refs.get(p.leadId) ?? null) : null,
      usesSprints: p.usesSprints,
      restrictTransitions: p.restrictTransitions,
      archivedAt: p.archivedAt?.toISOString() ?? null,
      statuses: statuses.filter((s) => s.projectId === p.id).map(statusDTO),
      transitions: transitions
        .filter((t) => t.projectId === p.id)
        .map((t) => ({ fromId: t.fromId, toId: t.toId })),
      labels: labels
        .filter((l) => l.projectId === p.id)
        .map((l) => ({ id: l.id, name: l.name, color: l.color })),
      fields: fields.filter((f) => f.projectId === p.id).map(fieldDTO),
      canEdit: workspaceRoleAtLeast(role, 'editor') && !p.archivedAt,
      canAdmin: role === 'owner' || (p.leadId === userId && workspaceRoleAtLeast(role, 'editor')),
      openCount: openBy.get(p.id) ?? 0,
      createdAt: p.createdAt.toISOString(),
    };
  });
}

/** Ticket rows → DTOs, with keys, people, child progress, comment counts and open blockers. */
export async function ticketDTOs(db: Db, rows: TicketRow[]): Promise<TicketDTO[]> {
  if (!rows.length) return [];
  const ids = rows.map((t) => t.id);
  const projectIds = [...new Set(rows.map((t) => t.projectId))];
  const [keys, refs, children, commentCounts, blockers] = await Promise.all([
    db
      .select({ id: projects.id, key: projects.key })
      .from(projects)
      .where(inArray(projects.id, projectIds)),
    loadUserRefs(db, [...rows.map((t) => t.assigneeId), ...rows.map((t) => t.reporterId)]),
    db
      .select({
        parentId: tickets.parentId,
        n: count(),
        done: sql<number>`count(*) filter (where ${projectStatuses.category} = 'done')`,
      })
      .from(tickets)
      .innerJoin(projectStatuses, eq(projectStatuses.id, tickets.statusId))
      .where(and(inArray(tickets.parentId, ids), isNull(tickets.deletedAt)))
      .groupBy(tickets.parentId),
    db
      .select({ ticketId: ticketComments.ticketId, n: count() })
      .from(ticketComments)
      .where(inArray(ticketComments.ticketId, ids))
      .groupBy(ticketComments.ticketId),
    db
      .select({ toId: ticketLinks.toId, number: tickets.number, projectId: tickets.projectId })
      .from(ticketLinks)
      .innerJoin(tickets, eq(tickets.id, ticketLinks.fromId))
      .innerJoin(projectStatuses, eq(projectStatuses.id, tickets.statusId))
      .where(
        and(
          inArray(ticketLinks.toId, ids),
          eq(ticketLinks.kind, 'blocks'),
          isNull(tickets.deletedAt),
          sql`${projectStatuses.category} <> 'done'`,
        ),
      ),
  ]);
  const keyOf = new Map(keys.map((k) => [k.id, k.key]));
  const blockerProjects = [...new Set(blockers.map((b) => b.projectId))].filter(
    (p) => !keyOf.has(p),
  );
  if (blockerProjects.length) {
    const more = await db
      .select({ id: projects.id, key: projects.key })
      .from(projects)
      .where(inArray(projects.id, blockerProjects));
    for (const k of more) keyOf.set(k.id, k.key);
  }
  const childBy = new Map(children.map((c) => [c.parentId!, c]));
  const commentsBy = new Map(commentCounts.map((c) => [c.ticketId, Number(c.n)]));
  const blockedBy = new Map<string, string[]>();
  for (const b of blockers) {
    const list = blockedBy.get(b.toId) ?? [];
    list.push(ticketKey(keyOf.get(b.projectId) ?? '?', b.number));
    blockedBy.set(b.toId, list);
  }
  return rows.map((t) => ({
    id: t.id,
    projectId: t.projectId,
    number: t.number,
    key: ticketKey(keyOf.get(t.projectId) ?? '?', t.number),
    type: t.type,
    parentId: t.parentId,
    title: t.title,
    description: t.description,
    statusId: t.statusId,
    priority: t.priority,
    assignee: t.assigneeId ? (refs.get(t.assigneeId) ?? null) : null,
    reporter: t.reporterId ? (refs.get(t.reporterId) ?? null) : null,
    sprintId: t.sprintId,
    storyPoints: t.storyPoints,
    estimateMinutes: t.estimateMinutes,
    spentMinutes: t.spentMinutes,
    startDate: t.startDate,
    dueDate: t.dueDate,
    rank: t.rank,
    resolution: t.resolution,
    labelIds: t.labelIds,
    fields: t.fields,
    childCount: Number(childBy.get(t.id)?.n ?? 0),
    childDoneCount: Number(childBy.get(t.id)?.done ?? 0),
    commentCount: commentsBy.get(t.id) ?? 0,
    blockedBy: blockedBy.get(t.id) ?? [],
    completedAt: t.completedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  }));
}

/** Compact references to tickets (with status and assignee). */
export async function ticketRefs(db: Db, ids: string[]): Promise<Map<string, TicketRefDTO>> {
  const uniq = [...new Set(ids)];
  const map = new Map<string, TicketRefDTO>();
  if (!uniq.length) return map;
  const rows = await db
    .select({
      id: tickets.id,
      projectId: tickets.projectId,
      number: tickets.number,
      title: tickets.title,
      type: tickets.type,
      assigneeId: tickets.assigneeId,
      key: projects.key,
      sId: projectStatuses.id,
      sName: projectStatuses.name,
      sColor: projectStatuses.color,
      sCat: projectStatuses.category,
    })
    .from(tickets)
    .innerJoin(projects, eq(projects.id, tickets.projectId))
    .innerJoin(projectStatuses, eq(projectStatuses.id, tickets.statusId))
    .where(and(inArray(tickets.id, uniq), isNull(tickets.deletedAt)));
  const refs = await loadUserRefs(
    db,
    rows.map((r) => r.assigneeId),
  );
  for (const r of rows)
    map.set(r.id, {
      id: r.id,
      projectId: r.projectId,
      key: ticketKey(r.key, r.number),
      title: r.title,
      type: r.type,
      status: { id: r.sId, name: r.sName, color: r.sColor, category: r.sCat },
      assignee: r.assigneeId ? (refs.get(r.assigneeId) ?? null) : null,
    });
  return map;
}

export interface Change {
  field: string;
  from: unknown;
  to: unknown;
}

export async function logEvents(
  db: Db,
  ticket: Pick<TicketRow, 'id' | 'projectId'>,
  actorId: string | null,
  changes: Change[],
  at = new Date(),
) {
  if (!changes.length) return;
  await db.insert(ticketEvents).values(
    changes.map((c) => ({
      ticketId: ticket.id,
      projectId: ticket.projectId,
      actorId,
      field: c.field,
      from: (c.from ?? null) as never,
      to: (c.to ?? null) as never,
      createdAt: at,
    })),
  );
}

export async function watch(db: Db, ticketId: string, userIds: (string | null | undefined)[]) {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  if (!ids.length) return;
  await db
    .insert(ticketWatchers)
    .values(ids.map((userId) => ({ ticketId, userId })))
    .onConflictDoNothing();
}

/** Members of the workspace (people tickets can be assigned to). */
export async function workspaceUsers(db: Db, workspaceId: string) {
  return db
    .select({
      id: users.id,
      name: users.name,
      avatarUrl: users.avatarUrl,
      color: users.color,
      email: users.email,
      role: workspaceMembers.role,
    })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(asc(users.name));
}

/**
 * Sends a ticket notification to each recipient who is still a member of the workspace,
 * except the actor.
 */
export async function notifyTicket(
  db: Db,
  opts: {
    project: ProjectRow;
    ticketId: string;
    actorId: string;
    kind: NotificationKind;
    recipients: (string | null | undefined)[];
    detail?: string | null;
  },
) {
  const ids = [...new Set(opts.recipients.filter((x): x is string => !!x && x !== opts.actorId))];
  if (!ids.length) return;
  const members = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(
      and(
        eq(workspaceMembers.workspaceId, opts.project.workspaceId),
        inArray(workspaceMembers.userId, ids),
      ),
    );
  await insertNotifications(
    db,
    members.map((m) => ({
      userId: m.userId,
      workspaceId: opts.project.workspaceId,
      kind: opts.kind,
      ticketId: opts.ticketId,
      actorId: opts.actorId,
      detail: opts.detail ? opts.detail.slice(0, 280) : null,
    })),
  );
}

export async function watcherIds(db: Db, ticketId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: ticketWatchers.userId })
    .from(ticketWatchers)
    .where(eq(ticketWatchers.ticketId, ticketId));
  return rows.map((r) => r.userId);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Checks a custom field value against its definition; returns the value to store. */
export function checkFieldValue(f: FieldRow, v: unknown, memberIds: Set<string>): FieldValue {
  if (v === null || v === undefined || v === '') return null;
  const bad = () => badRequest(`Invalid value for field “${f.name}”`, 'validation');
  switch (f.kind) {
    case 'text':
      if (typeof v !== 'string') throw bad();
      return v.slice(0, 2000);
    case 'url':
      if (typeof v !== 'string' || !/^https?:\/\//i.test(v)) throw bad();
      return v.slice(0, 2000);
    case 'number':
      if (typeof v !== 'number' || !Number.isFinite(v)) throw bad();
      return v;
    case 'checkbox':
      if (typeof v !== 'boolean') throw bad();
      return v;
    case 'date':
      if (typeof v !== 'string' || !DATE_RE.test(v)) throw bad();
      return v;
    case 'user':
      if (typeof v !== 'string' || !memberIds.has(v)) throw bad();
      return v;
    case 'select':
      if (typeof v !== 'string' || !f.options.some((o) => o.id === v)) throw bad();
      return v;
    case 'multi_select': {
      if (!Array.isArray(v)) throw bad();
      const ok = new Set(f.options.map((o) => o.id));
      const vals = [...new Set(v)].filter((x): x is string => typeof x === 'string');
      if (vals.some((x) => !ok.has(x))) throw bad();
      return vals;
    }
  }
}

// ---------- sprint reports ----------

const day = (d: Date) => d.toISOString().slice(0, 10);

function dayRange(from: string, to: string): string[] {
  const out: string[] = [];
  const d = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  for (let i = 0; d <= end && i < 120; i++) {
    out.push(day(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

interface Replay {
  inSprint: boolean;
  points: number;
  done: boolean;
}

/**
 * Remaining and total points of a sprint at the end of each day, replayed from ticket history
 * (sprint membership, story points, and status category changes).
 */
export async function sprintBurndown(db: Db, sprint: SprintRow) {
  const statuses = await projectStatusRows(db, sprint.projectId);
  const cat = new Map<string, StatusCategory>(statuses.map((s) => [s.id, s.category]));
  // Tickets that are, or ever were, in the sprint.
  const touched = await db
    .selectDistinct({ id: ticketEvents.ticketId })
    .from(ticketEvents)
    .where(
      and(
        eq(ticketEvents.projectId, sprint.projectId),
        or(
          and(eq(ticketEvents.field, 'sprint'), sql`(${ticketEvents.to} #>> '{}') = ${sprint.id}`),
          and(
            eq(ticketEvents.field, 'sprint'),
            sql`(${ticketEvents.from} #>> '{}') = ${sprint.id}`,
          ),
          and(
            eq(ticketEvents.field, 'created'),
            sql`(${ticketEvents.to} ->> 'sprintId') = ${sprint.id}`,
          ),
        ),
      ),
    );
  const current = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(and(eq(tickets.sprintId, sprint.id), isNull(tickets.deletedAt)));
  const ids = [...new Set([...touched.map((t) => t.id), ...current.map((t) => t.id)])];
  const events = ids.length
    ? await db
        .select()
        .from(ticketEvents)
        .where(
          and(
            inArray(ticketEvents.ticketId, ids),
            inArray(ticketEvents.field, ['created', 'sprint', 'storyPoints', 'status', 'deleted']),
          ),
        )
        .orderBy(asc(ticketEvents.createdAt))
    : [];
  const start = sprint.startDate ?? day(sprint.startedAt ?? sprint.createdAt);
  const end = sprint.endDate ?? day(new Date());
  const today = day(new Date());
  const days = dayRange(start, end);
  const state = new Map<string, Replay>();
  const apply = (e: (typeof events)[number]) => {
    const s = state.get(e.ticketId) ?? { inSprint: false, points: 0, done: false };
    if (e.field === 'created') {
      const to = (e.to ?? {}) as {
        sprintId?: string | null;
        storyPoints?: number | null;
        statusId?: string;
      };
      s.inSprint = to.sprintId === sprint.id;
      s.points = to.storyPoints ?? 0;
      s.done = cat.get(to.statusId ?? '') === 'done';
    } else if (e.field === 'sprint') s.inSprint = e.to === sprint.id;
    else if (e.field === 'storyPoints') s.points = typeof e.to === 'number' ? e.to : 0;
    else if (e.field === 'status') s.done = cat.get(String(e.to)) === 'done';
    else if (e.field === 'deleted') s.inSprint = false;
    state.set(e.ticketId, s);
  };
  const totals = () => {
    let scope = 0;
    let remaining = 0;
    for (const s of state.values()) {
      if (!s.inSprint) continue;
      scope += s.points;
      if (!s.done) remaining += s.points;
    }
    return { scope, remaining };
  };
  let i = 0;
  // State when the sprint started.
  const startAt = sprint.startedAt ?? new Date(start + 'T00:00:00Z');
  while (i < events.length && events[i]!.createdAt <= startAt) apply(events[i++]!);
  const initialScope = totals().scope;
  const out: { date: string; remaining: number; scope: number; completed: number }[] = [];
  for (const d of days) {
    if (d > today) break;
    const endOfDay = new Date(d + 'T23:59:59.999Z');
    while (i < events.length && events[i]!.createdAt <= endOfDay) apply(events[i++]!);
    const t = totals();
    out.push({ date: d, remaining: t.remaining, scope: t.scope, completed: t.scope - t.remaining });
  }
  while (i < events.length) apply(events[i++]!);
  const now = totals();
  return {
    days: out,
    remaining: now.remaining,
    scope: now.scope,
    added: Math.max(0, now.scope - initialScope),
    initialScope,
  };
}

/** Points and counts of a sprint's tickets right now. */
export async function sprintTotals(db: Db, sprintId: string) {
  const rows = await db
    .select({ points: tickets.storyPoints, category: projectStatuses.category })
    .from(tickets)
    .innerJoin(projectStatuses, eq(projectStatuses.id, tickets.statusId))
    .where(and(eq(tickets.sprintId, sprintId), isNull(tickets.deletedAt)));
  let points = 0;
  let donePoints = 0;
  let done = 0;
  for (const r of rows) {
    points += r.points ?? 0;
    if (r.category === 'done') {
      donePoints += r.points ?? 0;
      done++;
    }
  }
  return { points, donePoints, count: rows.length, done };
}

export const userRefList = (m: Map<string, UserRef>, ids: string[]) =>
  ids.map((id) => m.get(id)).filter((x): x is UserRef => !!x);
