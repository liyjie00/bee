/* CSV export of a project's tickets, and import from CSV (Bee's own export or a Jira export). */
import type { Priority, TicketType } from '@bee/shared';
import { TEMPLATE_STATUSES, ticketKey } from '@bee/shared';
import type { ProjectContext } from './ticket-ops.js';
import type { TicketRow } from './tickets.js';

/** RFC 4180 parser: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim()));
}

const cell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows: unknown[][]): string {
  return '\uFEFF' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

export function exportTickets(
  ctx: ProjectContext,
  rows: TicketRow[],
  people: Map<string, { name: string; email: string }>,
  labels: { id: string; name: string }[],
): string {
  const status = new Map(ctx.statuses.map((s) => [s.id, s.name]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const key = (r: TicketRow) => ticketKey(ctx.project.key, r.number);
  const head = [
    'Issue key',
    'Issue Type',
    'Summary',
    'Status',
    'Resolution',
    'Priority',
    'Assignee',
    'Reporter',
    'Parent',
    'Sprint',
    'Story Points',
    'Labels',
    'Start date',
    'Due date',
    'Original estimate (h)',
    'Time spent (h)',
    'Created',
    'Updated',
    'Description',
    ...ctx.fields.map((f) => f.name),
  ];
  const labelName = new Map(labels.map((l) => [l.id, l.name.replace(/\s+/g, '_')]));
  return toCsv([
    head,
    ...rows.map((r) => {
      const p = r.parentId ? byId.get(r.parentId) : undefined;
      return [
        key(r),
        r.type,
        r.title,
        status.get(r.statusId) ?? '',
        r.resolution ?? '',
        r.priority,
        r.assigneeId ? (people.get(r.assigneeId)?.email ?? '') : '',
        r.reporterId ? (people.get(r.reporterId)?.email ?? '') : '',
        p ? key(p) : '',
        r.sprintId ? (ctx.sprints.get(r.sprintId)?.name ?? '') : '',
        r.storyPoints ?? '',
        r.labelIds.map((id) => labelName.get(id) ?? id).join(' '),
        r.startDate ?? '',
        r.dueDate ?? '',
        r.estimateMinutes != null ? r.estimateMinutes / 60 : '',
        r.spentMinutes != null ? r.spentMinutes / 60 : '',
        r.createdAt.toISOString(),
        r.updatedAt.toISOString(),
        r.description,
        ...ctx.fields.map((f) => {
          const v = r.fields[f.id];
          if (v === undefined || v === null) return '';
          if (f.kind === 'select') return f.options.find((o) => o.id === v)?.label ?? '';
          if (f.kind === 'multi_select')
            return (v as string[])
              .map((id) => f.options.find((o) => o.id === id)?.label ?? '')
              .join(', ');
          if (f.kind === 'user') return people.get(String(v))?.email ?? '';
          return String(v);
        }),
      ];
    }),
  ]);
}

// ---------- import ----------

const norm = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');

/** Column names accepted for each field (Bee export, Jira export, common variants). */
const COLUMNS: Record<string, string[]> = {
  key: ['issue key', 'key', '编号'],
  type: ['issue type', 'type', '类型'],
  title: ['summary', 'title', '标题', '概要'],
  status: ['status', '状态'],
  priority: ['priority', '优先级'],
  assignee: ['assignee', '负责人', '经办人'],
  reporter: ['reporter', '报告人'],
  parent: ['parent', 'parent id', 'parent key', 'epic link', 'parent summary', '父工单'],
  sprint: ['sprint', '迭代'],
  points: [
    'story points',
    'custom field (story points)',
    'custom field (story point estimate)',
    'story point estimate',
    '故事点',
  ],
  labels: ['labels', 'label', '标签'],
  start: ['start date', 'custom field (start date)', '开始'],
  due: ['due date', 'due', '截止'],
  estimate: ['original estimate (h)', 'original estimate', '预估'],
  spent: ['time spent (h)', 'time spent', '已用'],
  description: ['description', '描述'],
  resolution: ['resolution', '解决方式'],
};

const TYPE_ALIASES: Record<string, TicketType> = {
  epic: 'epic',
  story: 'story',
  'user story': 'story',
  task: 'task',
  bug: 'bug',
  defect: 'bug',
  'sub task': 'subtask',
  subtask: 'subtask',
  'sub-task': 'subtask',
  improvement: 'task',
  'new feature': 'story',
  缺陷: 'bug',
  任务: 'task',
  子任务: 'subtask',
};

const PRIORITY_ALIASES: Record<string, Priority> = {
  highest: 'urgent',
  blocker: 'urgent',
  critical: 'urgent',
  urgent: 'urgent',
  紧急: 'urgent',
  high: 'high',
  major: 'high',
  高: 'high',
  medium: 'medium',
  中: 'medium',
  low: 'low',
  minor: 'low',
  lowest: 'low',
  trivial: 'low',
  低: 'low',
  none: 'none',
  无: 'none',
};

const DONE_WORDS =
  /^(done|closed|resolved|complete|completed|finished|已完成|完成|关闭|已关闭|已解决)$/;
const DOING_WORDS = /(progress|review|testing|qa|doing|进行|评审|测试|开发中)/;

export interface ImportRow {
  line: number;
  key: string | null;
  type: TicketType;
  title: string;
  statusId: string;
  priority: Priority;
  assigneeId: string | null;
  reporterId: string | null;
  parentKey: string | null;
  sprintName: string | null;
  storyPoints: number | null;
  labels: string[];
  startDate: string | null;
  dueDate: string | null;
  estimateMinutes: number | null;
  spentMinutes: number | null;
  description: string;
}

function toDate(s: string): string | null {
  const v = s.trim();
  if (!v) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  // Jira: 21/Nov/25 3:45 PM
  const m = /^(\d{1,2})\/([A-Za-z]{3})\/(\d{2,4})/.exec(v);
  if (m) {
    const months = [
      'jan',
      'feb',
      'mar',
      'apr',
      'may',
      'jun',
      'jul',
      'aug',
      'sep',
      'oct',
      'nov',
      'dec',
    ];
    const mo = months.indexOf(m[2]!.toLowerCase());
    if (mo >= 0) {
      const y = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      return `${y}-${String(mo + 1).padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
    }
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

function toHours(s: string): number | null {
  const v = s.trim();
  if (!v) return null;
  const n = Number(v);
  // Jira exports estimates in seconds; Bee's export in hours.
  if (!Number.isFinite(n)) return null;
  return n > 1000 ? Math.round(n / 60) : Math.round(n * 60);
}

/** Reads rows into ticket fields; unknown statuses map by their category words. */
export function readImport(
  table: string[][],
  ctx: ProjectContext,
  people: { id: string; name: string; email: string }[],
): { rows: ImportRow[]; errors: string[] } {
  const [header, ...body] = table;
  if (!header) return { rows: [], errors: ['The file is empty'] };
  const cols = header.map(norm);
  const idx = (k: string) => cols.findIndex((c) => COLUMNS[k]!.includes(c));
  const all = (k: string) => cols.flatMap((c, i) => (COLUMNS[k]!.includes(c) ? [i] : []));
  const at = (r: string[], k: string) => {
    const i = idx(k);
    return i >= 0 ? (r[i] ?? '').trim() : '';
  };
  if (idx('title') < 0) return { rows: [], errors: ['No “Summary” or “Title” column'] };

  const todo = ctx.statuses.find((s) => s.category === 'todo') ?? ctx.statuses[0]!;
  const doing = ctx.statuses.find((s) => s.category === 'doing') ?? todo;
  const done = ctx.statuses.find((s) => s.category === 'done') ?? todo;
  const aliases = new Map<string, string[]>();
  for (const list of Object.values(TEMPLATE_STATUSES))
    for (const s of list) {
      aliases.set(norm(s.en), [norm(s.zh)]);
      aliases.set(norm(s.zh), [norm(s.en)]);
    }
  const statusOf = (name: string) => {
    const n = norm(name);
    if (!n) return todo.id;
    const names = [n, ...(aliases.get(n) ?? [])];
    const hit = ctx.statuses.find((s) => names.includes(norm(s.name)));
    if (hit) return hit.id;
    if (DONE_WORDS.test(n)) return done.id;
    if (DOING_WORDS.test(n)) return doing.id;
    return todo.id;
  };
  const person = (v: string) => {
    const n = v.trim().toLowerCase();
    if (!n) return null;
    return (
      people.find((p) => p.email.toLowerCase() === n || p.name.toLowerCase() === n)?.id ?? null
    );
  };
  const rows: ImportRow[] = [];
  const errors: string[] = [];
  body.forEach((r, i) => {
    const line = i + 2;
    const title = at(r, 'title');
    if (!title) {
      errors.push(`Line ${line}: no title`);
      return;
    }
    const typeRaw = norm(at(r, 'type'));
    const type = TYPE_ALIASES[typeRaw] ?? (typeRaw ? 'task' : 'task');
    const pts = Number(at(r, 'points'));
    const labels = all('labels')
      .flatMap((c) => (r[c] ?? '').split(/[\s,;]+/))
      .map((x) => x.trim())
      .filter(Boolean);
    rows.push({
      line,
      key: at(r, 'key') || null,
      type,
      title: title.slice(0, 500),
      statusId: statusOf(at(r, 'status')),
      priority: PRIORITY_ALIASES[norm(at(r, 'priority'))] ?? 'medium',
      assigneeId: person(at(r, 'assignee')),
      reporterId: person(at(r, 'reporter')),
      parentKey: at(r, 'parent') || null,
      sprintName: at(r, 'sprint') || null,
      storyPoints: at(r, 'points') && Number.isFinite(pts) ? pts : null,
      labels: [...new Set(labels)],
      startDate: toDate(at(r, 'start')),
      dueDate: toDate(at(r, 'due')),
      estimateMinutes: toHours(at(r, 'estimate')),
      spentMinutes: toHours(at(r, 'spent')),
      description: at(r, 'description'),
    });
  });
  return { rows, errors };
}
