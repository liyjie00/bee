/* Creating and changing tickets, shared by the HTTP routes, bulk edits, CSV import and MCP. */
import { and, asc, eq, inArray, isNull, max, sql } from 'drizzle-orm';
import {
  projectFields,
  projectLabels,
  projectTransitions,
  projects,
  sprints,
  tickets,
  type Db,
} from '@bee/db';
import {
  allowedParentTypes,
  parentRequired,
  sprintable,
  type FieldValue,
  type Priority,
  type Resolution,
  type TicketType,
} from '@bee/shared';
import { badRequest, conflict, notFound } from './errors.js';
import {
  checkFieldValue,
  logEvents,
  notifyTicket,
  projectStatusRows,
  watch,
  watcherIds,
  workspaceUsers,
  type Change,
  type ProjectRow,
  type TicketRow,
} from './tickets.js';

export interface TicketInput {
  type?: TicketType;
  title?: string;
  description?: string;
  parentId?: string | null;
  statusId?: string;
  priority?: Priority;
  assigneeId?: string | null;
  reporterId?: string | null;
  sprintId?: string | null;
  storyPoints?: number | null;
  estimateMinutes?: number | null;
  spentMinutes?: number | null;
  startDate?: string | null;
  dueDate?: string | null;
  rank?: number;
  resolution?: Resolution | null;
  labelIds?: string[];
  /** merged into the ticket's values; null clears one */
  fields?: Record<string, unknown>;
}

/** Project data needed to validate ticket changes, loaded once per request (or bulk edit). */
export interface ProjectContext {
  project: ProjectRow;
  statuses: Awaited<ReturnType<typeof projectStatusRows>>;
  transitions: Set<string> | null;
  labelIds: Set<string>;
  fields: (typeof projectFields.$inferSelect)[];
  memberIds: Set<string>;
  sprints: Map<string, typeof sprints.$inferSelect>;
}

export async function projectContext(db: Db, project: ProjectRow): Promise<ProjectContext> {
  const [statuses, transitions, labels, fields, members, sprintRows] = await Promise.all([
    projectStatusRows(db, project.id),
    project.restrictTransitions
      ? db.select().from(projectTransitions).where(eq(projectTransitions.projectId, project.id))
      : Promise.resolve(null),
    db
      .select({ id: projectLabels.id })
      .from(projectLabels)
      .where(eq(projectLabels.projectId, project.id)),
    db
      .select()
      .from(projectFields)
      .where(eq(projectFields.projectId, project.id))
      .orderBy(asc(projectFields.position)),
    workspaceUsers(db, project.workspaceId),
    db.select().from(sprints).where(eq(sprints.projectId, project.id)),
  ]);
  return {
    project,
    statuses,
    transitions: transitions ? new Set(transitions.map((t) => `${t.fromId}>${t.toId}`)) : null,
    labelIds: new Set(labels.map((l) => l.id)),
    fields,
    memberIds: new Set(members.map((m) => m.id)),
    sprints: new Map(sprintRows.map((s) => [s.id, s])),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

async function loadParent(
  db: Db,
  ctx: ProjectContext,
  parentId: string,
  type: TicketType,
  selfId?: string,
) {
  if (parentId === selfId) throw badRequest('A ticket cannot be its own parent');
  const allowed = allowedParentTypes(type);
  if (!allowed) throw badRequest('Epics have no parent', 'bad_parent');
  const [p] = await db.select().from(tickets).where(eq(tickets.id, parentId)).limit(1);
  if (!p || p.deletedAt || p.projectId !== ctx.project.id)
    throw badRequest('Parent not found in this project', 'bad_parent');
  if (!allowed.includes(p.type))
    throw badRequest(`A ${type} cannot be under a ${p.type}`, 'bad_parent');
  return p;
}

function checkMember(ctx: ProjectContext, id: string | null | undefined, what: string) {
  if (id && !ctx.memberIds.has(id)) throw badRequest(`${what} must be a member of the workspace`);
}

function checkSprint(ctx: ProjectContext, sprintId: string | null | undefined) {
  if (!sprintId) return;
  const s = ctx.sprints.get(sprintId);
  if (!s) throw badRequest('Sprint not found in this project');
  if (s.state === 'closed') throw badRequest('That sprint is closed');
}

function checkFields(
  ctx: ProjectContext,
  type: TicketType,
  input: Record<string, unknown>,
  current: Record<string, FieldValue>,
) {
  const out = { ...current };
  for (const [id, v] of Object.entries(input)) {
    const f = ctx.fields.find((x) => x.id === id);
    if (!f) throw badRequest('Unknown field');
    if (f.appliesTo && !f.appliesTo.includes(type) && v !== null)
      throw badRequest(`“${f.name}” does not apply to ${type}`);
    const val = checkFieldValue(f, v, ctx.memberIds);
    if (val === null) delete out[id];
    else out[id] = val;
  }
  return out;
}

const isDone = (ctx: ProjectContext, statusId: string) =>
  ctx.statuses.find((s) => s.id === statusId)?.category === 'done';

/** Creates a ticket; returns its row. */
export async function createTicket(
  db: Db,
  ctx: ProjectContext,
  input: TicketInput & { type: TicketType; title: string },
  actorId: string,
): Promise<TicketRow> {
  const type = input.type;
  let parent: TicketRow | null = null;
  if (input.parentId) parent = await loadParent(db, ctx, input.parentId, type);
  else if (parentRequired(type)) throw badRequest('A subtask needs a parent', 'bad_parent');
  const defaultStatus = ctx.statuses.find((s) => s.category === 'todo') ?? ctx.statuses[0];
  const statusId = input.statusId ?? defaultStatus?.id;
  if (!statusId || !ctx.statuses.some((s) => s.id === statusId)) throw badRequest('Unknown status');
  checkMember(ctx, input.assigneeId, 'Assignee');
  checkMember(ctx, input.reporterId, 'Reporter');
  let sprintId = sprintable(type) ? (input.sprintId ?? null) : null;
  if (type === 'subtask') sprintId = parent?.sprintId ?? null;
  checkSprint(ctx, sprintId);
  const labelIds = [...new Set(input.labelIds ?? [])];
  if (labelIds.some((l) => !ctx.labelIds.has(l))) throw badRequest('Unknown label');
  const fields = checkFields(ctx, type, input.fields ?? {}, {});
  const done = isDone(ctx, statusId);
  const row = await db.transaction(async (tx) => {
    const [num] = await tx
      .update(projects)
      .set({ nextNumber: sql`${projects.nextNumber} + 1` })
      .where(eq(projects.id, ctx.project.id))
      .returning({ n: projects.nextNumber });
    const [r] = await tx
      .select({ m: max(tickets.rank) })
      .from(tickets)
      .where(eq(tickets.projectId, ctx.project.id));
    const [t] = await tx
      .insert(tickets)
      .values({
        projectId: ctx.project.id,
        number: num!.n - 1,
        type,
        parentId: parent?.id ?? null,
        title: input.title.trim().slice(0, 500),
        description: input.description ?? '',
        statusId,
        priority: input.priority ?? 'medium',
        assigneeId: input.assigneeId ?? null,
        reporterId: input.reporterId === undefined ? actorId : input.reporterId,
        sprintId,
        storyPoints: input.storyPoints ?? null,
        estimateMinutes: input.estimateMinutes ?? null,
        spentMinutes: input.spentMinutes ?? null,
        startDate: input.startDate ?? null,
        dueDate: input.dueDate ?? null,
        rank: input.rank ?? (r?.m ?? 0) + 1,
        resolution: done ? (input.resolution ?? 'done') : null,
        labelIds,
        fields,
        completedAt: done ? new Date() : null,
      })
      .returning();
    await logEvents(tx as unknown as Db, t!, actorId, [
      {
        field: 'created',
        from: null,
        to: { sprintId: t!.sprintId, storyPoints: t!.storyPoints, statusId: t!.statusId, type },
      },
    ]);
    return t!;
  });
  await watch(db, row.id, [actorId, row.assigneeId, row.reporterId]);
  if (row.assigneeId && row.assigneeId !== actorId)
    await notifyTicket(db, {
      project: ctx.project,
      ticketId: row.id,
      actorId,
      kind: 'ticket_assigned',
      recipients: [row.assigneeId],
      detail: row.title,
    });
  return row;
}

/** Applies a change to a ticket, records history and notifies watchers; returns the new row. */
export async function updateTicket(
  db: Db,
  ctx: ProjectContext,
  t: TicketRow,
  input: TicketInput,
  actorId: string,
): Promise<TicketRow> {
  const set: Partial<typeof tickets.$inferInsert> = {};
  const changes: Change[] = [];
  const put = <K extends keyof TicketRow>(
    field: K,
    value: TicketRow[K],
    event = field as string,
  ) => {
    if (same(t[field], value)) return;
    (set as Record<string, unknown>)[field] = value;
    changes.push({ field: event, from: t[field], to: value });
  };
  const type = input.type ?? t.type;

  if (input.title !== undefined) {
    const title = input.title.trim().slice(0, 500);
    if (!title) throw badRequest('Title is required');
    put('title', title);
  }
  if (input.description !== undefined) put('description', input.description);
  if (input.type !== undefined && input.type !== t.type) {
    const kids = await db
      .select({ type: tickets.type })
      .from(tickets)
      .where(and(eq(tickets.parentId, t.id), isNull(tickets.deletedAt)));
    if (kids.some((k) => !(allowedParentTypes(k.type) ?? []).includes(type)))
      throw badRequest(`Its child tickets cannot be under a ${type}`, 'bad_parent');
    put('type', type);
  }
  // Parent (re-validated when the type changes).
  const parentId = input.parentId !== undefined ? input.parentId : t.parentId;
  let parent: TicketRow | null = null;
  if (parentId) parent = await loadParent(db, ctx, parentId, type, t.id);
  else if (parentRequired(type)) throw badRequest('A subtask needs a parent', 'bad_parent');
  if (parent?.parentId === t.id) throw badRequest('That would make a loop', 'bad_parent');
  put('parentId', parentId ?? null, 'parent');

  if (input.statusId !== undefined && input.statusId !== t.statusId) {
    const to = ctx.statuses.find((s) => s.id === input.statusId);
    if (!to) throw badRequest('Unknown status');
    if (ctx.transitions && !ctx.transitions.has(`${t.statusId}>${to.id}`))
      throw conflict('This status change is not allowed by the workflow', 'transition_not_allowed');
    put('statusId', to.id, 'status');
    if (to.category === 'done') {
      const resolution = input.resolution ?? (to.requireResolution ? null : 'done');
      if (!resolution) throw badRequest('Choose a resolution', 'resolution_required');
      put('resolution', resolution);
      if (!t.completedAt || !isDone(ctx, t.statusId)) set.completedAt = new Date();
    } else {
      put('resolution', null);
      set.completedAt = null;
    }
  } else if (input.resolution !== undefined && isDone(ctx, t.statusId) && input.resolution) {
    put('resolution', input.resolution);
  }
  if (input.priority !== undefined) put('priority', input.priority);
  if (input.assigneeId !== undefined) {
    checkMember(ctx, input.assigneeId, 'Assignee');
    put('assigneeId', input.assigneeId, 'assignee');
  }
  if (input.reporterId !== undefined) {
    checkMember(ctx, input.reporterId, 'Reporter');
    put('reporterId', input.reporterId, 'reporter');
  }
  // Sprint: subtasks follow their parent, epics are never in one.
  let sprintId = input.sprintId !== undefined ? input.sprintId : t.sprintId;
  if (!sprintable(type)) sprintId = type === 'subtask' ? (parent?.sprintId ?? null) : null;
  if (sprintId !== t.sprintId) {
    checkSprint(ctx, sprintId);
    put('sprintId', sprintId, 'sprint');
  }
  if (input.storyPoints !== undefined) put('storyPoints', input.storyPoints);
  if (input.estimateMinutes !== undefined)
    put('estimateMinutes', input.estimateMinutes, 'estimate');
  if (input.spentMinutes !== undefined) put('spentMinutes', input.spentMinutes, 'spent');
  if (input.startDate !== undefined) put('startDate', input.startDate);
  if (input.dueDate !== undefined) put('dueDate', input.dueDate);
  const start = set.startDate !== undefined ? set.startDate : t.startDate;
  const due = set.dueDate !== undefined ? set.dueDate : t.dueDate;
  if (start && due && due < start) throw badRequest('The due date is before the start date');
  if (input.rank !== undefined && input.rank !== t.rank) set.rank = input.rank;
  if (input.labelIds !== undefined) {
    const ids = [...new Set(input.labelIds)];
    if (ids.some((l) => !ctx.labelIds.has(l))) throw badRequest('Unknown label');
    put('labelIds', ids, 'labels');
  }
  if (input.fields !== undefined) {
    const next = checkFields(ctx, type, input.fields, t.fields);
    for (const id of new Set([...Object.keys(t.fields), ...Object.keys(next)])) {
      if (!same(t.fields[id], next[id]))
        changes.push({ field: `field:${id}`, from: t.fields[id] ?? null, to: next[id] ?? null });
    }
    if (!same(t.fields, next)) set.fields = next;
  }
  if (!Object.keys(set).length) return t;
  set.updatedAt = new Date();
  const [row] = await db.transaction(async (tx) => {
    const r = await tx.update(tickets).set(set).where(eq(tickets.id, t.id)).returning();
    await logEvents(tx as unknown as Db, t, actorId, changes);
    // Subtasks move with their parent.
    if (set.sprintId !== undefined && sprintable(type)) {
      const kids = await tx
        .update(tickets)
        .set({ sprintId: set.sprintId, updatedAt: new Date() })
        .where(and(eq(tickets.parentId, t.id), eq(tickets.type, 'subtask')))
        .returning({ id: tickets.id, projectId: tickets.projectId, sprintId: tickets.sprintId });
      for (const k of kids)
        await logEvents(tx as unknown as Db, k, actorId, [
          { field: 'sprint', from: t.sprintId, to: set.sprintId },
        ]);
    }
    return r;
  });
  if (!row) throw notFound('Ticket not found');

  // Notifications.
  if (set.assigneeId) {
    await watch(db, t.id, [set.assigneeId]);
    await notifyTicket(db, {
      project: ctx.project,
      ticketId: t.id,
      actorId,
      kind: 'ticket_assigned',
      recipients: [set.assigneeId],
      detail: row.title,
    });
  }
  if (set.statusId) {
    const name = ctx.statuses.find((s) => s.id === set.statusId)?.name ?? '';
    const watchers = await watcherIds(db, t.id);
    await notifyTicket(db, {
      project: ctx.project,
      ticketId: t.id,
      actorId,
      kind: 'ticket_update',
      recipients: watchers.filter((w) => w !== set.assigneeId),
      detail: name,
    });
  }
  return row;
}

/** Soft-deletes a ticket and its children. */
export async function deleteTicket(db: Db, t: TicketRow, actorId: string) {
  const kids = await db
    .select({ id: tickets.id, projectId: tickets.projectId })
    .from(tickets)
    .where(and(eq(tickets.parentId, t.id), isNull(tickets.deletedAt)));
  const grand = kids.length
    ? await db
        .select({ id: tickets.id, projectId: tickets.projectId })
        .from(tickets)
        .where(
          and(
            inArray(
              tickets.parentId,
              kids.map((k) => k.id),
            ),
            isNull(tickets.deletedAt),
          ),
        )
    : [];
  // Stories under a deleted epic stay, without the epic; subtasks go with their parent.
  const all = [t, ...kids, ...grand];
  const doomed = t.type === 'epic' ? [t] : all;
  const now = new Date();
  await db.transaction(async (tx) => {
    if (t.type === 'epic' && kids.length)
      await tx
        .update(tickets)
        .set({ parentId: null, updatedAt: now })
        .where(
          inArray(
            tickets.id,
            kids.map((k) => k.id),
          ),
        );
    await tx
      .update(tickets)
      .set({ deletedAt: now, updatedAt: now })
      .where(
        inArray(
          tickets.id,
          doomed.map((d) => d.id),
        ),
      );
    for (const d of doomed)
      await logEvents(
        tx as unknown as Db,
        d,
        actorId,
        [{ field: 'deleted', from: null, to: true }],
        now,
      );
  });
  return doomed.map((d) => d.id);
}
