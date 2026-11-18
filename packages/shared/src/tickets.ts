/**
 * Ticket management (projects, tickets, sprints): constants, DTOs and pure helpers shared by
 * the API, the web app and the MCP tools.
 *
 * Hierarchy: epic → story / task / bug → subtask. Each project defines its own statuses; every
 * status belongs to one of three categories (todo / doing / done) that reports and "is it done"
 * checks rely on.
 */
import type { DocumentType, UserRef } from './api.js';

export const TICKET_TYPES = ['epic', 'story', 'task', 'bug', 'subtask'] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

export const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const STATUS_CATEGORIES = ['todo', 'doing', 'done'] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

export const RESOLUTIONS = ['done', 'wont_do', 'duplicate', 'cannot_reproduce'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export const FIELD_KINDS = [
  'text',
  'number',
  'select',
  'multi_select',
  'date',
  'user',
  'checkbox',
  'url',
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/** Stored direction: "from blocks to", "from duplicates to", "from relates to to". */
export const LINK_KINDS = ['blocks', 'duplicates', 'relates'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const PROJECT_TEMPLATES = ['scrum', 'kanban', 'simple'] as const;
export type ProjectTemplate = (typeof PROJECT_TEMPLATES)[number];

export const SPRINT_STATES = ['planned', 'active', 'closed'] as const;
export type SprintState = (typeof SPRINT_STATES)[number];

/** Project keys: 2–10 capital letters or digits, starting with a letter (BEE, WEB2). */
export const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;
/** A ticket key such as BEE-24. */
export const TICKET_KEY_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,7})\b/;

export const ticketKey = (projectKey: string, num: number) => `${projectKey}-${num}`;

export function parseTicketKey(s: string): { key: string; number: number } | null {
  const m = new RegExp(`^${TICKET_KEY_RE.source}$`).exec(s.trim().toUpperCase());
  return m ? { key: m[1]!, number: Number(m[2]) } : null;
}

/** Which ticket types may be the parent of a ticket of `type` (null: none allowed). */
export function allowedParentTypes(type: TicketType): TicketType[] | null {
  switch (type) {
    case 'epic':
      return null;
    case 'subtask':
      return ['story', 'task', 'bug'];
    default:
      return ['epic'];
  }
}

/** Subtasks must have a parent; everything else may stand alone. */
export const parentRequired = (type: TicketType) => type === 'subtask';

/** Epics span sprints and subtasks follow their parent, so neither is planned on its own. */
export const sprintable = (type: TicketType) => type !== 'epic' && type !== 'subtask';

export interface StatusDTO {
  id: string;
  name: string;
  color: string;
  category: StatusCategory;
  position: number;
  /** cards allowed in the column before it is flagged (null: no limit) */
  wipLimit: number | null;
  /** moving here asks for a resolution */
  requireResolution: boolean;
}

export interface TransitionDTO {
  fromId: string;
  toId: string;
}

export interface LabelDTO {
  id: string;
  name: string;
  color: string;
}

export interface FieldOption {
  id: string;
  label: string;
  color: string;
}

export interface FieldDTO {
  id: string;
  name: string;
  kind: FieldKind;
  /** for select / multi_select */
  options: FieldOption[];
  /** ticket types the field shows on (null: all) */
  appliesTo: TicketType[] | null;
  position: number;
}

/** A custom field value: string (text, url, date YYYY-MM-DD, select option id, user id), number, boolean, or string[] (multi_select). */
export type FieldValue = string | number | boolean | string[] | null;

export interface ProjectDTO {
  id: string;
  workspaceId: string;
  name: string;
  key: string;
  color: string;
  description: string;
  template: ProjectTemplate;
  lead: UserRef | null;
  usesSprints: boolean;
  /** only the transitions listed are allowed */
  restrictTransitions: boolean;
  archivedAt: string | null;
  statuses: StatusDTO[];
  transitions: TransitionDTO[];
  labels: LabelDTO[];
  fields: FieldDTO[];
  /** the caller may create and edit tickets */
  canEdit: boolean;
  /** the caller may change project settings */
  canAdmin: boolean;
  openCount: number;
  createdAt: string;
}

export interface SprintDTO {
  id: string;
  projectId: string;
  name: string;
  goal: string;
  startDate: string | null;
  endDate: string | null;
  state: SprintState;
  /** planned story points */
  capacity: number | null;
  completedAt: string | null;
  /** points committed when it started and completed when it closed */
  summary: SprintSummary | null;
}

export interface SprintSummary {
  committedPoints: number;
  completedPoints: number;
  completedCount: number;
  incompleteCount: number;
}

/** Compact reference, used in links, parents and document chips. */
export interface TicketRefDTO {
  id: string;
  projectId: string;
  key: string;
  title: string;
  type: TicketType;
  status: { id: string; name: string; color: string; category: StatusCategory };
  assignee: UserRef | null;
}

export interface TicketDTO {
  id: string;
  projectId: string;
  number: number;
  key: string;
  type: TicketType;
  parentId: string | null;
  title: string;
  description: string;
  statusId: string;
  priority: Priority;
  assignee: UserRef | null;
  reporter: UserRef | null;
  sprintId: string | null;
  storyPoints: number | null;
  estimateMinutes: number | null;
  spentMinutes: number | null;
  startDate: string | null;
  dueDate: string | null;
  rank: number;
  resolution: Resolution | null;
  labelIds: string[];
  fields: Record<string, FieldValue>;
  childCount: number;
  childDoneCount: number;
  commentCount: number;
  /** keys of open tickets that block this one */
  blockedBy: string[];
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TicketLinkDTO {
  id: string;
  kind: LinkKind;
  /** out: this ticket blocks / duplicates / relates to the other; in: the other way round */
  direction: 'out' | 'in';
  ticket: TicketRefDTO;
}

export interface TicketDocumentDTO {
  id: string;
  title: string;
  type: DocumentType;
  /** manual: linked by hand; mention: the document references the ticket */
  source: 'manual' | 'mention';
}

export interface TicketCommentDTO {
  id: string;
  author: UserRef | null;
  body: string;
  createdAt: string;
  editedAt: string | null;
  mine: boolean;
}

export interface TicketEventDTO {
  id: string;
  actor: UserRef | null;
  /** created, title, status, assignee, … or field:<id> for custom fields */
  field: string;
  from: unknown;
  to: unknown;
  createdAt: string;
}

export interface TicketDetailDTO extends TicketDTO {
  project: { id: string; key: string; name: string; color: string; workspaceId: string };
  parent: TicketRefDTO | null;
  children: TicketDTO[];
  links: TicketLinkDTO[];
  documents: TicketDocumentDTO[];
  watchers: UserRef[];
  watching: boolean;
  comments: TicketCommentDTO[];
  events: TicketEventDTO[];
  canEdit: boolean;
  canComment: boolean;
}

// ---------- filters and saved views ----------

export interface TicketFilter {
  q?: string;
  types?: TicketType[];
  statusIds?: string[];
  categories?: StatusCategory[];
  /** user ids; 'me' is the caller, 'none' unassigned */
  assignees?: string[];
  priorities?: Priority[];
  labelIds?: string[];
  /** 'active' current sprint, 'backlog' no sprint, or a sprint id */
  sprint?: string;
  /** tickets under this epic (directly, or as subtasks of its children) */
  epicId?: string;
  due?: 'overdue' | 'week' | 'none';
  /** custom field id → wanted value (option id, user id, text contains, true) */
  fields?: Record<string, string | boolean>;
}

export const VIEW_KINDS = ['board', 'list', 'backlog', 'timeline'] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

export const GROUP_BYS = [
  'none',
  'status',
  'assignee',
  'priority',
  'type',
  'epic',
  'sprint',
] as const;
export type GroupBy = (typeof GROUP_BYS)[number];

export const SWIMLANES = ['none', 'epic', 'assignee', 'priority'] as const;
export type Swimlane = (typeof SWIMLANES)[number];

export const SORT_BYS = ['rank', 'priority', 'dueDate', 'updatedAt', 'createdAt', 'key'] as const;
export type SortBy = (typeof SORT_BYS)[number];

export interface ViewConfig {
  view: ViewKind;
  filter: TicketFilter;
  groupBy?: GroupBy;
  swimlane?: Swimlane;
  sortBy?: SortBy;
}

export interface SavedViewDTO {
  id: string;
  workspaceId: string;
  projectId: string | null;
  name: string;
  config: ViewConfig;
  /** visible to everyone in the workspace (otherwise only to its owner) */
  shared: boolean;
  mine: boolean;
}

const PRIORITY_RANK: Record<Priority, number> = { none: 0, low: 1, medium: 2, high: 3, urgent: 4 };
export const priorityRank = (p: Priority) => PRIORITY_RANK[p];

export interface FilterContext {
  userId: string;
  statuses: Map<string, { category: StatusCategory }>;
  activeSprintIds: Set<string>;
  /** ticket id → parent id, to find a subtask's epic */
  parentOf: (id: string) => string | null;
  /** YYYY-MM-DD of "today" for due-date filters */
  today: string;
}

const addDays = (day: string, n: number) => {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Whether a ticket passes a filter. Used both by the API (search, MCP) and in the browser. */
export function matchesFilter(t: TicketDTO, f: TicketFilter, ctx: FilterContext): boolean {
  if (f.q) {
    const q = f.q.trim().toLowerCase();
    if (q && !t.title.toLowerCase().includes(q) && !t.key.toLowerCase().includes(q)) return false;
  }
  if (f.types?.length && !f.types.includes(t.type)) return false;
  if (f.statusIds?.length && !f.statusIds.includes(t.statusId)) return false;
  if (f.categories?.length) {
    const c = ctx.statuses.get(t.statusId)?.category;
    if (!c || !f.categories.includes(c)) return false;
  }
  if (f.assignees?.length) {
    const a = t.assignee?.id ?? null;
    const ok = f.assignees.some((x) =>
      x === 'none' ? a === null : x === 'me' ? a === ctx.userId : a === x,
    );
    if (!ok) return false;
  }
  if (f.priorities?.length && !f.priorities.includes(t.priority)) return false;
  if (f.labelIds?.length && !f.labelIds.some((l) => t.labelIds.includes(l))) return false;
  if (f.sprint) {
    if (f.sprint === 'backlog') {
      if (t.sprintId) return false;
    } else if (f.sprint === 'active') {
      if (!t.sprintId || !ctx.activeSprintIds.has(t.sprintId)) return false;
    } else if (t.sprintId !== f.sprint) return false;
  }
  if (f.epicId) {
    let p = t.parentId;
    let hops = 0;
    let hit = false;
    while (p && hops++ < 4) {
      if (p === f.epicId) {
        hit = true;
        break;
      }
      p = ctx.parentOf(p);
    }
    if (!hit) return false;
  }
  if (f.due) {
    if (f.due === 'none' && t.dueDate) return false;
    if (f.due === 'overdue') {
      const done = ctx.statuses.get(t.statusId)?.category === 'done';
      if (!t.dueDate || done || t.dueDate >= ctx.today) return false;
    }
    if (
      f.due === 'week' &&
      (!t.dueDate || t.dueDate < ctx.today || t.dueDate > addDays(ctx.today, 7))
    )
      return false;
  }
  if (f.fields) {
    for (const [id, want] of Object.entries(f.fields)) {
      const v = t.fields[id];
      if (typeof want === 'boolean') {
        if (!!v !== want) return false;
      } else if (Array.isArray(v)) {
        if (!v.includes(want)) return false;
      } else if (typeof v === 'string') {
        if (v !== want && !v.toLowerCase().includes(want.toLowerCase())) return false;
      } else if (v === null || v === undefined || String(v) !== want) return false;
    }
  }
  return true;
}

/** Comparator for list views. */
export function compareTickets(by: SortBy): (a: TicketDTO, b: TicketDTO) => number {
  switch (by) {
    case 'priority':
      return (a, b) => priorityRank(b.priority) - priorityRank(a.priority) || a.rank - b.rank;
    case 'dueDate':
      return (a, b) =>
        (a.dueDate ?? '9999') < (b.dueDate ?? '9999')
          ? -1
          : (a.dueDate ?? '9999') > (b.dueDate ?? '9999')
            ? 1
            : a.rank - b.rank;
    case 'updatedAt':
      return (a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);
    case 'createdAt':
      return (a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);
    case 'key':
      return (a, b) => a.number - b.number;
    default:
      return (a, b) => a.rank - b.rank;
  }
}

/** Rank between two neighbours (either may be missing), for drag-and-drop ordering. */
export function rankBetween(
  before: number | null | undefined,
  after: number | null | undefined,
): number {
  if (before == null && after == null) return 1;
  if (before == null) return after! - 1;
  if (after == null) return before + 1;
  return (before + after) / 2;
}

/** Day-by-day remaining points of a sprint, for the burndown chart. */
export interface BurndownDTO {
  sprint: SprintDTO;
  days: { date: string; remaining: number; scope: number; completed: number }[];
  /** points still open now */
  remaining: number;
  scope: number;
  /** points added after the sprint started */
  added: number;
}

export interface VelocityDTO {
  sprints: { id: string; name: string; committed: number; completed: number }[];
  average: number;
}

export interface WorkloadDTO {
  rows: { user: UserRef | null; todo: number; doing: number; done: number; count: number }[];
}

/** Default statuses of each project template, in board order. */
export const TEMPLATE_STATUSES: Record<
  ProjectTemplate,
  { en: string; zh: string; category: StatusCategory; color: string; requireResolution?: boolean }[]
> = {
  scrum: [
    { en: 'To do', zh: '待办', category: 'todo', color: '#7b8375' },
    { en: 'In progress', zh: '进行中', category: 'doing', color: '#e8a317' },
    { en: 'In review', zh: '评审中', category: 'doing', color: '#3b7dd8' },
    { en: 'Done', zh: '已完成', category: 'done', color: '#1e6b2a' },
  ],
  kanban: [
    { en: 'Backlog', zh: '待规划', category: 'todo', color: '#9aa294' },
    { en: 'Ready', zh: '待开始', category: 'todo', color: '#7b8375' },
    { en: 'In progress', zh: '进行中', category: 'doing', color: '#e8a317' },
    { en: 'Done', zh: '已完成', category: 'done', color: '#1e6b2a' },
  ],
  simple: [
    { en: 'To do', zh: '待办', category: 'todo', color: '#7b8375' },
    { en: 'Doing', zh: '进行中', category: 'doing', color: '#e8a317' },
    { en: 'Done', zh: '已完成', category: 'done', color: '#1e6b2a' },
  ],
};

export const LABEL_COLORS = [
  '#3b7dd8',
  '#1e6b2a',
  '#c2410c',
  '#7c3aed',
  '#e8a317',
  '#0e7490',
  '#be185d',
  '#4a5146',
];
