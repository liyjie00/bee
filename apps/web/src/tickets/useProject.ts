/* Data of one ticket project (settings, members, sprints, tickets), kept fresh by polling. */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FilterContext, ProjectDTO, SprintDTO, StatusDTO, TicketDTO } from '@bee/shared';
import { tickets as api, type Member, type TicketPatch } from '../api/tickets';
import { errMsg, useToast } from '../state/toast';
import { today } from './ui';

const POLL_MS = 8000;
const PROJECTS_EVENT = 'bee:projects-changed';

/** Tells every list of projects (the sidebar) to reload. */
export const projectsChanged = () => dispatchEvent(new Event(PROJECTS_EVENT));

/** Projects of a workspace, reloaded when one is created, renamed or deleted. */
export function useWorkspaceProjects(workspaceId: string | null | undefined) {
  const [projects, setProjects] = useState<ProjectDTO[] | null>(null);
  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    const load = () =>
      api.projects(workspaceId).then(
        (p) => live && setProjects(p),
        () => live && setProjects([]),
      );
    void load();
    addEventListener(PROJECTS_EVENT, load);
    return () => {
      live = false;
      removeEventListener(PROJECTS_EVENT, load);
    };
  }, [workspaceId]);
  return projects;
}

export interface ProjectData {
  project: ProjectDTO;
  members: Member[];
  sprints: SprintDTO[];
  tickets: TicketDTO[];
  byId: Map<string, TicketDTO>;
  status: (id: string) => StatusDTO | undefined;
  activeSprint: SprintDTO | null;
  filterCtx: FilterContext;
  epics: TicketDTO[];
  /** optimistic update; reverts and reports on failure */
  update(id: string, patch: TicketPatch): Promise<TicketDTO | null>;
  upsert(t: TicketDTO | TicketDTO[]): void;
  drop(ids: string[]): void;
  reload(): Promise<void>;
  reloadProject(): Promise<void>;
}

export function useProject(projectId: string, userId: string) {
  const toast = useToast();
  const [meta, setMeta] = useState<{
    project: ProjectDTO;
    members: Member[];
    sprints: SprintDTO[];
  } | null>(null);
  const [list, setList] = useState<Map<string, TicketDTO> | null>(null);
  const [error, setError] = useState<unknown>(null);
  const since = useRef<string | null>(null);

  const reloadProject = useCallback(async () => {
    const r = await api.project(projectId);
    setMeta(r);
  }, [projectId]);

  const reload = useCallback(async () => {
    const r = await api.list(projectId);
    since.current = r.now;
    setList(new Map(r.tickets.map((t) => [t.id, t])));
  }, [projectId]);

  useEffect(() => {
    setMeta(null);
    setList(null);
    setError(null);
    since.current = null;
    Promise.all([reloadProject(), reload()]).catch(setError);
  }, [projectId]);

  // Changes by other people show up within a few seconds while the tab is visible.
  useEffect(() => {
    const tick = async () => {
      if (document.hidden || !since.current) return;
      try {
        const r = await api.list(projectId, since.current);
        since.current = r.now;
        if (!r.tickets.length && !r.deleted.length) return;
        setList((m) => {
          if (!m) return m;
          const n = new Map(m);
          for (const t of r.tickets) n.set(t.id, t);
          for (const id of r.deleted) n.delete(id);
          return n;
        });
      } catch {
        /* offline: try again next time */
      }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    const vis = () => !document.hidden && void tick();
    document.addEventListener('visibilitychange', vis);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [projectId]);

  const upsert = useCallback((t: TicketDTO | TicketDTO[]) => {
    const arr = Array.isArray(t) ? t : [t];
    setList((m) => {
      if (!m) return m;
      const n = new Map(m);
      for (const x of arr) n.set(x.id, x);
      return n;
    });
  }, []);
  const drop = useCallback((ids: string[]) => {
    setList((m) => {
      if (!m) return m;
      const n = new Map(m);
      for (const id of ids) n.delete(id);
      return n;
    });
  }, []);

  const data = useMemo<ProjectData | null>(() => {
    if (!meta || !list) return null;
    const statuses = new Map(meta.project.statuses.map((s) => [s.id, s]));
    const all = [...list.values()].sort((a, b) => a.rank - b.rank);
    const activeSprint = meta.sprints.find((s) => s.state === 'active') ?? null;
    return {
      ...meta,
      tickets: all,
      byId: list,
      status: (id) => statuses.get(id),
      activeSprint,
      epics: all.filter((t) => t.type === 'epic'),
      filterCtx: {
        userId,
        statuses,
        activeSprintIds: new Set(activeSprint ? [activeSprint.id] : []),
        parentOf: (id) => list.get(id)?.parentId ?? null,
        today: today(),
      },
      update: async (id, patch) => {
        const before = list.get(id);
        if (before) {
          const optimistic: TicketDTO = { ...before };
          if (patch.statusId) optimistic.statusId = patch.statusId;
          if (patch.rank !== undefined) optimistic.rank = patch.rank;
          if (patch.sprintId !== undefined) optimistic.sprintId = patch.sprintId;
          if (patch.priority) optimistic.priority = patch.priority;
          if (patch.title) optimistic.title = patch.title;
          if (patch.assigneeId !== undefined)
            optimistic.assignee = patch.assigneeId
              ? (meta.members.find((m) => m.id === patch.assigneeId) ?? null)
              : null;
          upsert(optimistic);
        }
        try {
          const t = await api.update(id, patch);
          upsert(t);
          return t;
        } catch (e) {
          if (before) upsert(before);
          toast(errMsg(e));
          return null;
        }
      },
      upsert,
      drop,
      reload,
      reloadProject,
    };
  }, [meta, list, userId]);

  return { data, error };
}
