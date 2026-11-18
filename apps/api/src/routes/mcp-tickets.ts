/* MCP tools for ticket projects: find, read, create and update tickets, comment, link, sprints.
 * Like the other tools they call the regular /api routes as the caller. */
import { z } from 'zod';
import {
  LINK_KINDS,
  PRIORITIES,
  RESOLUTIONS,
  TEMPLATE_STATUSES,
  TICKET_TYPES,
  parseTicketKey,
  type ProjectDTO,
  type SprintDTO,
  type TicketDetailDTO,
  type TicketDTO,
  type TicketFilter,
  type WorkspaceDTO,
  type WorkspaceMemberDTO,
} from '@bee/shared';
import { ToolError, type Ctx, type Tool } from './mcp.js';

const tool = <S extends z.ZodType>(t: Tool<S>) => t as unknown as Tool;
const json = (v: unknown) => JSON.stringify(v, null, 2);

interface ProjectInfo {
  project: ProjectDTO;
  members: WorkspaceMemberDTO[];
  sprints: SprintDTO[];
}

async function workspaces(ctx: Ctx): Promise<WorkspaceDTO[]> {
  return (await ctx.call<{ workspaces: WorkspaceDTO[] }>('GET', '/api/workspaces')).workspaces;
}

async function allProjects(ctx: Ctx, workspaceId?: string): Promise<ProjectDTO[]> {
  const ids = workspaceId ? [workspaceId] : (await workspaces(ctx)).map((w) => w.id);
  const lists = await Promise.all(
    ids.map((ws) => ctx.call<{ projects: ProjectDTO[] }>('GET', `/api/workspaces/${ws}/projects`)),
  );
  return lists.flatMap((l) => l.projects);
}

/** A project by id or key (keys are unique per workspace). */
async function findProject(ctx: Ctx, ref: string, workspaceId?: string): Promise<ProjectInfo> {
  let id = ref;
  if (!z.uuid().safeParse(ref).success) {
    const key = ref.trim().toUpperCase();
    const hits = (await allProjects(ctx, workspaceId)).filter((p) => p.key === key);
    if (!hits.length) throw new ToolError(`No project with key ${key}. Use list_projects.`);
    if (hits.length > 1)
      throw new ToolError(`Several projects use key ${key}; pass workspaceId or the project id.`);
    id = hits[0]!.id;
  }
  const r = await ctx.call<{ project: ProjectDTO; sprints: SprintDTO[] }>(
    'GET',
    `/api/projects/${id}`,
  );
  const { members } = await ctx.call<{ members: WorkspaceMemberDTO[] }>(
    'GET',
    `/api/workspaces/${r.project.workspaceId}/members`,
  );
  return { project: r.project, sprints: r.sprints, members };
}

/** A ticket by id or key (BEE-24). */
async function findTicket(ctx: Ctx, ref: string, workspaceId?: string): Promise<TicketDetailDTO> {
  if (z.uuid().safeParse(ref).success)
    return (await ctx.call<{ ticket: TicketDetailDTO }>('GET', `/api/tickets/${ref}`)).ticket;
  const k = parseTicketKey(ref);
  if (!k) throw new ToolError(`“${ref}” is not a ticket id or key like BEE-24`);
  const ids = workspaceId ? [workspaceId] : (await workspaces(ctx)).map((w) => w.id);
  for (const ws of ids) {
    try {
      return (
        await ctx.call<{ ticket: TicketDetailDTO }>(
          'GET',
          `/api/workspaces/${ws}/tickets/${encodeURIComponent(ref.toUpperCase())}`,
        )
      ).ticket;
    } catch {
      /* not in this workspace */
    }
  }
  throw new ToolError(`Ticket ${ref.toUpperCase()} not found`);
}

const norm = (s: string) => s.trim().toLowerCase();

function memberId(info: ProjectInfo, who: string, meId: string): string | null {
  const w = norm(who);
  if (w === 'me') return meId;
  if (w === 'none' || w === '') return null;
  const m = info.members.find(
    (x) => x.user.id === who || norm(x.user.email) === w || norm(x.user.name) === w,
  );
  if (!m) throw new ToolError(`No member “${who}” in this workspace (use a name, email or "me")`);
  return m.user.id;
}

/** Default status names in the other language ("In progress" ↔ "进行中"). */
const STATUS_ALIASES = new Map<string, string[]>();
for (const list of Object.values(TEMPLATE_STATUSES))
  for (const s of list) {
    STATUS_ALIASES.set(norm(s.en), [...(STATUS_ALIASES.get(norm(s.en)) ?? []), norm(s.zh)]);
    STATUS_ALIASES.set(norm(s.zh), [...(STATUS_ALIASES.get(norm(s.zh)) ?? []), norm(s.en)]);
  }

function statusId(info: ProjectInfo, name: string): string {
  const names = [norm(name), ...(STATUS_ALIASES.get(norm(name)) ?? [])];
  const s =
    info.project.statuses.find((x) => x.id === name || norm(x.name) === norm(name)) ??
    info.project.statuses.find((x) => names.includes(norm(x.name)));
  if (!s)
    throw new ToolError(
      `No status “${name}”. Statuses: ${info.project.statuses.map((x) => x.name).join(', ')}`,
    );
  return s.id;
}

function sprintId(info: ProjectInfo, name: string): string | null {
  const n = norm(name);
  if (n === 'backlog' || n === 'none' || n === '') return null;
  if (n === 'active') {
    const a = info.sprints.find((s) => s.state === 'active');
    if (!a) throw new ToolError('No active sprint');
    return a.id;
  }
  const s = info.sprints.find((x) => x.id === name || norm(x.name) === n);
  if (!s)
    throw new ToolError(
      `No sprint “${name}”. Sprints: ${info.sprints.map((x) => x.name).join(', ')}`,
    );
  return s.id;
}

async function labelIds(ctx: Ctx, info: ProjectInfo, names: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const name of names) {
    const hit = info.project.labels.find((l) => l.id === name || norm(l.name) === norm(name));
    if (hit) out.push(hit.id);
    else {
      // New labels are created on the fly.
      const { label } = await ctx.call<{ label: { id: string } }>(
        'POST',
        `/api/projects/${info.project.id}/labels`,
        { name },
      );
      out.push(label.id);
    }
  }
  return out;
}

/** Custom field values given by field name; option values by label. */
function fieldValues(info: ProjectInfo, fields: Record<string, unknown>, meId: string) {
  const out: Record<string, unknown> = {};
  for (const [name, v] of Object.entries(fields)) {
    const f = info.project.fields.find((x) => x.id === name || norm(x.name) === norm(name));
    if (!f)
      throw new ToolError(
        `No field “${name}”. Fields: ${info.project.fields.map((x) => x.name).join(', ') || 'none'}`,
      );
    const opt = (s: unknown) => {
      const o = f.options.find((x) => x.id === s || norm(x.label) === norm(String(s)));
      if (!o) throw new ToolError(`“${String(s)}” is not an option of ${f.name}`);
      return o.id;
    };
    if (v === null) out[f.id] = null;
    else if (f.kind === 'select') out[f.id] = opt(v);
    else if (f.kind === 'multi_select') out[f.id] = (Array.isArray(v) ? v : [v]).map(opt);
    else if (f.kind === 'user') out[f.id] = memberId(info, String(v), meId);
    else out[f.id] = v;
  }
  return out;
}

const fieldsInput = z
  .record(z.string(), z.unknown())
  .optional()
  .describe('Custom fields by name, e.g. {"Customer": "Acme"}; select options by label');

const editable = {
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(200_000).optional().describe('Markdown'),
  type: z.enum(TICKET_TYPES).optional(),
  status: z.string().optional().describe('Status name, e.g. "In progress"'),
  assignee: z.string().optional().describe('Name, email, "me", or "none"'),
  priority: z.enum(PRIORITIES).optional(),
  parent: z
    .string()
    .optional()
    .describe(
      'Key of the parent: an epic for stories/tasks/bugs, a story/task/bug for subtasks; "none" to clear',
    ),
  sprint: z.string().optional().describe('Sprint name, "active", or "backlog"'),
  storyPoints: z.number().min(0).max(1000).nullable().optional(),
  labels: z
    .array(z.string())
    .optional()
    .describe('Label names (created if new); replaces the labels'),
  startDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
  estimateHours: z.number().min(0).nullable().optional(),
  spentHours: z.number().min(0).nullable().optional(),
  fields: fieldsInput,
};

async function toPatch(
  ctx: Ctx,
  info: ProjectInfo,
  a: { [K in keyof typeof editable]?: unknown } & { resolution?: string | null },
  workspaceId: string,
) {
  const p: Record<string, unknown> = {};
  if (a.title !== undefined) p.title = a.title;
  if (a.description !== undefined) p.description = a.description;
  if (a.type !== undefined) p.type = a.type;
  if (a.status !== undefined) p.statusId = statusId(info, String(a.status));
  if (a.assignee !== undefined) p.assigneeId = memberId(info, String(a.assignee), ctx.userId);
  if (a.priority !== undefined) p.priority = a.priority;
  if (a.parent !== undefined) {
    const s = String(a.parent);
    p.parentId = norm(s) === 'none' || !s ? null : (await findTicket(ctx, s, workspaceId)).id;
  }
  if (a.sprint !== undefined) p.sprintId = sprintId(info, String(a.sprint));
  if (a.storyPoints !== undefined) p.storyPoints = a.storyPoints;
  if (a.labels !== undefined) p.labelIds = await labelIds(ctx, info, a.labels as string[]);
  if (a.startDate !== undefined) p.startDate = a.startDate;
  if (a.dueDate !== undefined) p.dueDate = a.dueDate;
  if (a.estimateHours !== undefined)
    p.estimateMinutes = a.estimateHours === null ? null : Math.round(Number(a.estimateHours) * 60);
  if (a.spentHours !== undefined)
    p.spentMinutes = a.spentHours === null ? null : Math.round(Number(a.spentHours) * 60);
  if (a.fields !== undefined)
    p.fields = fieldValues(info, a.fields as Record<string, unknown>, ctx.userId);
  if (a.resolution !== undefined) p.resolution = a.resolution;
  return p;
}

function ticketLine(t: TicketDTO, info?: ProjectInfo) {
  const st = info?.project.statuses.find((s) => s.id === t.statusId)?.name ?? t.statusId;
  const sprint = t.sprintId ? info?.sprints.find((s) => s.id === t.sprintId)?.name : null;
  return `- ${t.key} [${t.type}] ${t.title} — ${st}, ${t.priority}${t.assignee ? `, ${t.assignee.name}` : ', unassigned'}${t.storyPoints != null ? `, ${t.storyPoints} pts` : ''}${sprint ? `, ${sprint}` : ''}${t.dueDate ? `, due ${t.dueDate}` : ''} (id: ${t.id})`;
}

async function renderTicket(ctx: Ctx, t: TicketDetailDTO): Promise<string> {
  const info = await findProject(ctx, t.projectId);
  const st = info.project.statuses.find((s) => s.id === t.statusId);
  const sprint = info.sprints.find((s) => s.id === t.sprintId);
  const labels = info.project.labels.filter((l) => t.labelIds.includes(l.id)).map((l) => l.name);
  const custom = info.project.fields
    .filter((f) => t.fields[f.id] !== undefined)
    .map((f) => {
      const v = t.fields[f.id];
      const show =
        f.kind === 'select'
          ? f.options.find((o) => o.id === v)?.label
          : f.kind === 'multi_select'
            ? (v as string[]).map((id) => f.options.find((o) => o.id === id)?.label).join(', ')
            : f.kind === 'user'
              ? info.members.find((m) => m.user.id === v)?.user.name
              : String(v);
      return `${f.name}: ${show}`;
    });
  const lines = [
    `# ${t.key} ${t.title}`,
    `Type: ${t.type} · Status: ${st?.name} (${st?.category})${t.resolution ? ` · Resolution: ${t.resolution}` : ''} · Priority: ${t.priority}`,
    `Project: ${info.project.name} (${info.project.key}) · URL: ${ctx.publicUrl}/t/${t.id}`,
    `Assignee: ${t.assignee?.name ?? 'unassigned'} · Reporter: ${t.reporter?.name ?? '—'} · Watchers: ${t.watchers.map((w) => w.name).join(', ') || '—'}`,
    `Parent: ${t.parent ? `${t.parent.key} ${t.parent.title}` : '—'} · Sprint: ${sprint?.name ?? (info.project.usesSprints ? 'backlog' : '—')} · Story points: ${t.storyPoints ?? '—'}`,
    `Dates: ${t.startDate ?? '…'} → ${t.dueDate ?? '…'} · Time: ${t.spentMinutes ? `${t.spentMinutes / 60}h` : '0h'} of ${t.estimateMinutes ? `${t.estimateMinutes / 60}h` : '—'}`,
    labels.length ? `Labels: ${labels.join(', ')}` : '',
    custom.length ? custom.join(' · ') : '',
    '',
    t.description || '(no description)',
  ];
  if (t.children.length)
    lines.push('', '## Child tickets', ...t.children.map((c) => ticketLine(c, info)));
  if (t.links.length)
    lines.push(
      '',
      '## Links',
      ...t.links.map(
        (l) =>
          `- ${l.direction === 'out' ? l.kind : `is ${l.kind === 'blocks' ? 'blocked' : l.kind === 'duplicates' ? 'duplicated' : 'related'} by`} ${l.ticket.key} ${l.ticket.title} (${l.ticket.status.name})`,
      ),
    );
  if (t.documents.length)
    lines.push(
      '',
      '## Documents',
      ...t.documents.map((d) => `- ${d.title} (id: ${d.id}, ${d.source})`),
    );
  if (t.comments.length)
    lines.push(
      '',
      '## Comments',
      ...t.comments.map((c) => `- ${c.author?.name ?? '?'}, ${c.createdAt}: ${c.body}`),
    );
  return lines.filter((l, i) => l !== '' || lines[i - 1] !== '').join('\n');
}

export const TICKET_TOOLS: Tool[] = [
  tool({
    name: 'list_projects',
    title: 'List ticket projects',
    description:
      'Lists ticket projects (Jira-like: epics, stories, tasks, bugs, subtasks) with their keys, statuses, labels, custom fields and sprints.',
    input: z.object({ workspaceId: z.uuid().optional().describe('Only this workspace') }),
    readOnly: true,
    run: async (a, ctx) => {
      const ps = await allProjects(ctx, a.workspaceId);
      if (!ps.length) return 'No projects. Create one in the Bee web app (Projects › New project).';
      const out = [];
      for (const p of ps) {
        const { sprints } = await ctx.call<{ sprints: SprintDTO[] }>(
          'GET',
          `/api/projects/${p.id}/sprints`,
        );
        out.push({
          id: p.id,
          key: p.key,
          name: p.name,
          workspaceId: p.workspaceId,
          template: p.template,
          archived: !!p.archivedAt,
          openTickets: p.openCount,
          statuses: p.statuses.map((s) => `${s.name} (${s.category})`),
          labels: p.labels.map((l) => l.name),
          customFields: p.fields.map((f) => ({
            name: f.name,
            kind: f.kind,
            options: f.options.map((o) => o.label),
          })),
          sprints: p.usesSprints
            ? sprints
                .filter((s) => s.state !== 'closed')
                .map(
                  (s) =>
                    `${s.name} (${s.state}${s.startDate ? `, ${s.startDate} → ${s.endDate}` : ''})`,
                )
            : undefined,
          canEdit: p.canEdit,
        });
      }
      return json(out);
    },
  }),
  tool({
    name: 'search_tickets',
    title: 'Search tickets',
    description:
      'Finds tickets by text, type, status, assignee, sprint, epic, label or priority. Returns one line per ticket with its key and id.',
    input: z.object({
      project: z.string().optional().describe('Project key or id (default: all projects)'),
      workspaceId: z.uuid().optional(),
      query: z.string().max(200).optional().describe('Text in the title or key'),
      types: z.array(z.enum(TICKET_TYPES)).optional(),
      status: z.array(z.string()).optional().describe('Status names (needs project)'),
      category: z
        .array(z.enum(['todo', 'doing', 'done']))
        .optional()
        .describe('Status categories'),
      assignee: z.string().optional().describe('"me", "none", or a name/email (needs project)'),
      sprint: z
        .string()
        .optional()
        .describe('"active", "backlog", or a sprint name (needs project for names)'),
      epic: z.string().optional().describe('Epic key, e.g. BEE-10'),
      labels: z.array(z.string()).optional().describe('Label names (needs project)'),
      priorities: z.array(z.enum(PRIORITIES)).optional(),
      overdue: z.boolean().optional(),
      limit: z.number().int().min(1).max(200).default(50),
    }),
    readOnly: true,
    run: async (a, ctx) => {
      const info = a.project ? await findProject(ctx, a.project, a.workspaceId) : undefined;
      const f: TicketFilter = {};
      if (a.query) f.q = a.query;
      if (a.types) f.types = a.types;
      if (a.category) f.categories = a.category;
      if (a.priorities) f.priorities = a.priorities;
      if (a.overdue) f.due = 'overdue';
      if (a.assignee) {
        const n = norm(a.assignee);
        if (n === 'me' || n === 'none') f.assignees = [n];
        else if (info) f.assignees = [memberId(info, a.assignee, ctx.userId)!];
        else throw new ToolError('Pass project to filter by a person’s name');
      }
      if (a.status) {
        if (!info) throw new ToolError('Pass project to filter by status name, or use category');
        f.statusIds = a.status.map((s) => statusId(info, s));
      }
      if (a.sprint) {
        const n = norm(a.sprint);
        if (n === 'active' || n === 'backlog') f.sprint = n;
        else if (info) f.sprint = sprintId(info, a.sprint) ?? 'backlog';
        else throw new ToolError('Pass project to filter by a sprint name');
      }
      if (a.labels) {
        if (!info) throw new ToolError('Pass project to filter by label');
        f.labelIds = info.project.labels
          .filter((l) => a.labels!.some((n) => norm(n) === norm(l.name)))
          .map((l) => l.id);
      }
      if (a.epic)
        f.epicId = (await findTicket(ctx, a.epic, info?.project.workspaceId ?? a.workspaceId)).id;
      const { tickets } = await ctx.call<{ tickets: TicketDTO[] }>('POST', '/api/tickets/search', {
        workspaceId: info?.project.workspaceId ?? a.workspaceId,
        projectIds: info ? [info.project.id] : undefined,
        filter: f,
        limit: a.limit,
        sortBy: 'priority',
      });
      if (!tickets.length) return 'No tickets match.';
      const infos = new Map<string, ProjectInfo>();
      if (info) infos.set(info.project.id, info);
      for (const pid of new Set(tickets.map((t) => t.projectId)))
        if (!infos.has(pid)) infos.set(pid, await findProject(ctx, pid));
      return tickets.map((t) => ticketLine(t, infos.get(t.projectId))).join('\n');
    },
  }),
  tool({
    name: 'read_ticket',
    title: 'Read a ticket',
    description:
      'Shows a ticket with all fields, its description (Markdown), child tickets, links, linked documents and comments.',
    input: z.object({
      ticket: z.string().describe('Key (BEE-24) or id'),
      workspaceId: z.uuid().optional(),
    }),
    readOnly: true,
    run: async (a, ctx) => renderTicket(ctx, await findTicket(ctx, a.ticket, a.workspaceId)),
  }),
  tool({
    name: 'create_ticket',
    title: 'Create a ticket',
    description:
      'Creates a ticket in a project. Types: epic, story, task, bug, subtask (a subtask needs a parent story/task/bug; stories, tasks and bugs may sit under an epic).',
    input: z.object({
      project: z.string().describe('Project key or id'),
      workspaceId: z.uuid().optional(),
      ...editable,
      title: z.string().min(1).max(500),
      type: z.enum(TICKET_TYPES).default('task'),
      documentId: z.uuid().optional().describe('Link this document to the ticket'),
    }),
    run: async (a, ctx) => {
      const info = await findProject(ctx, a.project, a.workspaceId);
      const body = await toPatch(ctx, info, a, info.project.workspaceId);
      const { ticket } = await ctx.call<{ ticket: TicketDTO }>(
        'POST',
        `/api/projects/${info.project.id}/tickets`,
        {
          ...body,
          type: a.type,
          title: a.title,
          documentId: a.documentId,
        },
      );
      return `Created ${ticket.key}: ${ticket.title}\n${ctx.publicUrl}/t/${ticket.id} (id: ${ticket.id})`;
    },
  }),
  tool({
    name: 'create_tickets',
    title: 'Create several tickets',
    description:
      'Creates many tickets in one project at once (e.g. action items from meeting notes). Items take the same fields as create_ticket; "parent" may name a key created earlier in the same call.',
    input: z.object({
      project: z.string().describe('Project key or id'),
      workspaceId: z.uuid().optional(),
      items: z
        .array(
          z.object({
            ...editable,
            title: z.string().min(1).max(500),
            type: z.enum(TICKET_TYPES).default('task'),
          }),
        )
        .min(1)
        .max(100),
    }),
    run: async (a, ctx) => {
      const info = await findProject(ctx, a.project, a.workspaceId);
      const out: string[] = [];
      for (const item of a.items) {
        try {
          const body = await toPatch(ctx, info, item, info.project.workspaceId);
          const { ticket } = await ctx.call<{ ticket: TicketDTO }>(
            'POST',
            `/api/projects/${info.project.id}/tickets`,
            {
              ...body,
              type: item.type,
              title: item.title,
            },
          );
          out.push(`- ${ticket.key} ${ticket.title} (id: ${ticket.id})`);
        } catch (e) {
          out.push(`- FAILED “${item.title}”: ${(e as Error).message}`);
        }
      }
      return `Created in ${info.project.key}:\n${out.join('\n')}`;
    },
  }),
  tool({
    name: 'update_ticket',
    title: 'Update a ticket',
    description:
      'Changes fields of a ticket: title, description (Markdown, replaces it), type, status, assignee, priority, parent, sprint, story points, labels, dates, time, custom fields. Moving to a done status that requires a resolution needs "resolution".',
    input: z.object({
      ticket: z.string().describe('Key (BEE-24) or id'),
      workspaceId: z.uuid().optional(),
      ...editable,
      resolution: z.enum(RESOLUTIONS).optional(),
    }),
    run: async (a, ctx) => {
      const t = await findTicket(ctx, a.ticket, a.workspaceId);
      const info = await findProject(ctx, t.projectId);
      const patch = await toPatch(ctx, info, a, info.project.workspaceId);
      if (!Object.keys(patch).length) return 'Nothing to change.';
      const { ticket } = await ctx.call<{ ticket: TicketDTO }>(
        'PATCH',
        `/api/tickets/${t.id}`,
        patch,
      );
      return `Updated ${ticket.key}.\n${ticketLine(ticket, info)}`;
    },
  }),
  tool({
    name: 'comment_on_ticket',
    title: 'Comment on a ticket',
    description: 'Adds a comment to a ticket. "@Name" mentions a member and notifies them.',
    input: z.object({
      ticket: z.string(),
      body: z.string().min(1).max(20_000),
      workspaceId: z.uuid().optional(),
    }),
    run: async (a, ctx) => {
      const t = await findTicket(ctx, a.ticket, a.workspaceId);
      await ctx.call('POST', `/api/tickets/${t.id}/comments`, { body: a.body });
      return `Commented on ${t.key}.`;
    },
  }),
  tool({
    name: 'link_tickets',
    title: 'Link two tickets',
    description: 'Records that one ticket blocks, duplicates or relates to another.',
    input: z.object({
      ticket: z.string().describe('Key or id'),
      kind: z.enum(LINK_KINDS),
      target: z.string().describe('Key or id of the other ticket'),
      direction: z
        .enum(['out', 'in'])
        .default('out')
        .describe('out: ticket <kind> target; in: target <kind> ticket'),
      workspaceId: z.uuid().optional(),
    }),
    run: async (a, ctx) => {
      const t = await findTicket(ctx, a.ticket, a.workspaceId);
      const other = await findTicket(ctx, a.target, t.project.workspaceId);
      await ctx.call('POST', `/api/tickets/${t.id}/links`, {
        kind: a.kind,
        direction: a.direction,
        targetId: other.id,
      });
      return a.direction === 'out'
        ? `${t.key} ${a.kind} ${other.key}.`
        : `${other.key} ${a.kind} ${t.key}.`;
    },
  }),
  tool({
    name: 'list_sprints',
    title: 'List sprints',
    description:
      'Lists a project’s sprints with dates, goals and progress (story points done / total).',
    input: z.object({ project: z.string(), workspaceId: z.uuid().optional() }),
    readOnly: true,
    run: async (a, ctx) => {
      const info = await findProject(ctx, a.project, a.workspaceId);
      if (!info.project.usesSprints) return `${info.project.key} does not use sprints.`;
      const { tickets } = await ctx.call<{ tickets: TicketDTO[] }>(
        'GET',
        `/api/projects/${info.project.id}/tickets`,
      );
      const done = new Set(
        info.project.statuses.filter((s) => s.category === 'done').map((s) => s.id),
      );
      return (
        info.sprints
          .map((s) => {
            const ts = tickets.filter((t) => t.sprintId === s.id);
            const pts = ts.reduce((n, t) => n + (t.storyPoints ?? 0), 0);
            const dp = ts
              .filter((t) => done.has(t.statusId))
              .reduce((n, t) => n + (t.storyPoints ?? 0), 0);
            const summary =
              s.state === 'closed' && s.summary
                ? `completed ${s.summary.completedPoints}/${s.summary.committedPoints} pts`
                : `${dp}/${pts} pts done, ${ts.length} tickets`;
            return `- ${s.name} [${s.state}] ${s.startDate ?? '…'} → ${s.endDate ?? '…'}${s.goal ? ` — ${s.goal}` : ''}: ${summary} (id: ${s.id})`;
          })
          .join('\n') || 'No sprints.'
      );
    },
  }),
];
