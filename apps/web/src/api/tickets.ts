/* Ticket projects: projects and their settings, tickets, sprints, reports and saved views. */
import { req } from './http';
import type {
  BurndownDTO,
  FieldDTO,
  FieldKind,
  FieldOption,
  LabelDTO,
  LinkKind,
  ProjectDTO,
  ProjectTemplate,
  SavedViewDTO,
  SprintDTO,
  StatusCategory,
  StatusDTO,
  TicketAttachmentDTO,
  TicketCommentDTO,
  TicketDetailDTO,
  TicketDTO,
  TicketFilter,
  TicketRefDTO,
  TicketType,
  TransitionDTO,
  UserRef,
  VelocityDTO,
  ViewConfig,
  WorkloadDTO,
  WorkspaceRole,
} from '@bee/shared';

export type Member = UserRef & { role: WorkspaceRole };

/** Fields a ticket can be created or changed with. */
export interface TicketPatch {
  type?: TicketType;
  title?: string;
  description?: string;
  parentId?: string | null;
  statusId?: string;
  priority?: TicketDTO['priority'];
  assigneeId?: string | null;
  reporterId?: string | null;
  sprintId?: string | null;
  storyPoints?: number | null;
  estimateMinutes?: number | null;
  spentMinutes?: number | null;
  startDate?: string | null;
  dueDate?: string | null;
  rank?: number;
  resolution?: TicketDTO['resolution'];
  labelIds?: string[];
  fields?: Record<string, unknown>;
}

const enc = encodeURIComponent;

export const tickets = {
  projects: async (ws: string) =>
    (await req<{ projects: ProjectDTO[] }>('GET', `/workspaces/${ws}/projects`)).projects,
  createProject: async (
    ws: string,
    body: {
      name: string;
      key: string;
      color?: string;
      description?: string;
      template: ProjectTemplate;
    },
  ) => (await req<{ project: ProjectDTO }>('POST', `/workspaces/${ws}/projects`, body)).project,
  project: (id: string) =>
    req<{ project: ProjectDTO; members: Member[]; sprints: SprintDTO[] }>('GET', `/projects/${id}`),
  updateProject: async (
    id: string,
    patch: Partial<{
      name: string;
      key: string;
      color: string;
      description: string;
      leadId: string | null;
      usesSprints: boolean;
      restrictTransitions: boolean;
      archived: boolean;
    }>,
  ) => (await req<{ project: ProjectDTO }>('PATCH', `/projects/${id}`, patch)).project,
  deleteProject: (id: string) => req('DELETE', `/projects/${id}`),

  addStatus: async (
    id: string,
    body: { name: string; category: StatusCategory; color?: string; wipLimit?: number | null },
  ) => (await req<{ status: StatusDTO }>('POST', `/projects/${id}/statuses`, body)).status,
  updateStatus: async (
    id: string,
    statusId: string,
    patch: Partial<Omit<StatusDTO, 'id' | 'position'>>,
  ) =>
    (await req<{ status: StatusDTO }>('PATCH', `/projects/${id}/statuses/${statusId}`, patch))
      .status,
  deleteStatus: (id: string, statusId: string, moveTo: string) =>
    req('DELETE', `/projects/${id}/statuses/${statusId}?moveTo=${moveTo}`),
  orderStatuses: (id: string, ids: string[]) => req('PUT', `/projects/${id}/status-order`, { ids }),
  setTransitions: (id: string, transitions: TransitionDTO[]) =>
    req('PUT', `/projects/${id}/transitions`, { transitions }),

  addLabel: async (id: string, name: string, color?: string) =>
    (await req<{ label: LabelDTO }>('POST', `/projects/${id}/labels`, { name, color })).label,
  updateLabel: (id: string, labelId: string, patch: { name?: string; color?: string }) =>
    req('PATCH', `/projects/${id}/labels/${labelId}`, patch),
  deleteLabel: (id: string, labelId: string) => req('DELETE', `/projects/${id}/labels/${labelId}`),

  addField: async (
    id: string,
    body: {
      name: string;
      kind: FieldKind;
      options?: Partial<FieldOption>[];
      appliesTo?: TicketType[] | null;
    },
  ) => (await req<{ field: FieldDTO }>('POST', `/projects/${id}/fields`, body)).field,
  updateField: async (
    id: string,
    fieldId: string,
    patch: {
      name?: string;
      options?: Partial<FieldOption>[];
      appliesTo?: TicketType[] | null;
      position?: number;
    },
  ) => (await req<{ field: FieldDTO }>('PATCH', `/projects/${id}/fields/${fieldId}`, patch)).field,
  deleteField: (id: string, fieldId: string) => req('DELETE', `/projects/${id}/fields/${fieldId}`),

  list: (projectId: string, since?: string) =>
    req<{ tickets: TicketDTO[]; deleted: string[]; now: string }>(
      'GET',
      `/projects/${projectId}/tickets${since ? `?since=${enc(since)}` : ''}`,
    ),
  create: async (
    projectId: string,
    body: TicketPatch & { title: string; type: TicketType; documentId?: string },
  ) => (await req<{ ticket: TicketDTO }>('POST', `/projects/${projectId}/tickets`, body)).ticket,
  get: async (id: string) =>
    (await req<{ ticket: TicketDetailDTO }>('GET', `/tickets/${id}`)).ticket,
  byKey: async (ws: string, key: string) =>
    (await req<{ ticket: TicketDetailDTO }>('GET', `/workspaces/${ws}/tickets/${enc(key)}`)).ticket,
  update: async (id: string, patch: TicketPatch) =>
    (await req<{ ticket: TicketDTO }>('PATCH', `/tickets/${id}`, patch)).ticket,
  bulk: (ids: string[], patch: TicketPatch | null, del = false) =>
    req<{ updated: TicketDTO[]; deleted: string[]; errors: { id: string; message: string }[] }>(
      'POST',
      '/tickets/bulk',
      del ? { ids, delete: true } : { ids, patch },
    ),
  remove: async (id: string) =>
    (await req<{ deleted: string[] }>('DELETE', `/tickets/${id}`)).deleted,
  search: async (body: {
    workspaceId?: string;
    projectIds?: string[];
    filter: TicketFilter;
    limit?: number;
  }) => (await req<{ tickets: TicketDTO[] }>('POST', '/tickets/search', body)).tickets,
  mine: async (ws?: string) =>
    (await req<{ tickets: TicketDTO[] }>('GET', `/my-tickets${ws ? `?workspaceId=${ws}` : ''}`))
      .tickets,
  refs: async (ids: string[]) =>
    (await req<{ tickets: TicketRefDTO[] }>('POST', '/tickets/refs', { ids })).tickets,
  forDocument: async (docId: string) =>
    (await req<{ tickets: TicketRefDTO[] }>('GET', `/documents/${docId}/tickets`)).tickets,

  comment: async (id: string, body: string) =>
    (await req<{ comment: TicketCommentDTO }>('POST', `/tickets/${id}/comments`, { body })).comment,
  editComment: (id: string, body: string) => req('PATCH', `/ticket-comments/${id}`, { body }),
  deleteComment: (id: string) => req('DELETE', `/ticket-comments/${id}`),
  watch: (id: string, on: boolean) => req(on ? 'PUT' : 'DELETE', `/tickets/${id}/watch`),
  setWatcher: (id: string, userId: string, watching: boolean) =>
    req('POST', `/tickets/${id}/watchers`, { userId, watching }),
  link: (
    id: string,
    body: { kind: LinkKind; direction: 'out' | 'in'; targetId?: string; targetKey?: string },
  ) => req('POST', `/tickets/${id}/links`, body),
  unlink: (linkId: string) => req('DELETE', `/ticket-links/${linkId}`),
  linkDocument: (id: string, documentId: string) =>
    req('POST', `/tickets/${id}/documents`, { documentId }),
  unlinkDocument: (id: string, documentId: string) =>
    req('DELETE', `/tickets/${id}/documents/${documentId}`),
  upload: (id: string, file: File) => {
    const fd = new FormData();
    fd.append('file', file, file.name);
    return req<TicketAttachmentDTO>('POST', `/tickets/${id}/uploads`, fd);
  },
  deleteUpload: (id: string, uploadId: string) =>
    req('DELETE', `/tickets/${id}/uploads/${uploadId}`),

  sprints: async (projectId: string) =>
    (await req<{ sprints: SprintDTO[] }>('GET', `/projects/${projectId}/sprints`)).sprints,
  createSprint: async (
    projectId: string,
    body: Partial<Pick<SprintDTO, 'name' | 'goal' | 'startDate' | 'endDate' | 'capacity'>> = {},
  ) => (await req<{ sprint: SprintDTO }>('POST', `/projects/${projectId}/sprints`, body)).sprint,
  updateSprint: async (
    id: string,
    patch: Partial<Pick<SprintDTO, 'name' | 'goal' | 'startDate' | 'endDate' | 'capacity'>>,
  ) => (await req<{ sprint: SprintDTO }>('PATCH', `/sprints/${id}`, patch)).sprint,
  startSprint: async (id: string, body: { startDate?: string; endDate?: string; goal?: string }) =>
    (await req<{ sprint: SprintDTO }>('POST', `/sprints/${id}/start`, body)).sprint,
  completeSprint: (id: string, moveTo: string) =>
    req<{ sprint: SprintDTO; moved: number; movedTo: string | null }>(
      'POST',
      `/sprints/${id}/complete`,
      { moveTo },
    ),
  deleteSprint: (id: string) => req('DELETE', `/sprints/${id}`),
  burndown: (id: string) => req<BurndownDTO>('GET', `/sprints/${id}/burndown`),
  velocity: (projectId: string) => req<VelocityDTO>('GET', `/projects/${projectId}/velocity`),
  workload: (projectId: string, sprintId?: string) =>
    req<WorkloadDTO>(
      'GET',
      `/projects/${projectId}/workload${sprintId ? `?sprintId=${sprintId}` : ''}`,
    ),

  importCsv: (projectId: string, csv: string) =>
    req<{ created: number; errors: string[]; errorCount: number }>('POST', `/projects/${projectId}/import`, { csv }),

  views: async (ws: string) =>
    (await req<{ views: SavedViewDTO[] }>('GET', `/workspaces/${ws}/views`)).views,
  saveView: async (
    ws: string,
    body: { name: string; projectId: string | null; config: ViewConfig; shared?: boolean },
  ) => (await req<{ view: SavedViewDTO }>('POST', `/workspaces/${ws}/views`, body)).view,
  updateView: async (id: string, patch: { name?: string; config?: ViewConfig; shared?: boolean }) =>
    (await req<{ view: SavedViewDTO }>('PATCH', `/views/${id}`, patch)).view,
  deleteView: (id: string) => req('DELETE', `/views/${id}`),
};
