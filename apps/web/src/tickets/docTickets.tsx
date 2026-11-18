/* Tickets inside documents: lookups for the editor ("#" menu, live status dots) and the
 * "new ticket" dialog it opens, with the document linked to the new ticket. */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { TicketHit, TicketHost } from '@bee/editor';
import type { ProjectDTO, TicketRefDTO } from '@bee/shared';
import { tickets as api } from '../api/tickets';
import { useT } from '../i18n';
import { errMsg, useToast } from '../state/toast';
import { CreateTicketDialog, type CreateContext } from './CreateTicketDialog';

const LAST_PROJECT = 'bee.tk.lastProject';

const hit = (r: TicketRefDTO): TicketHit => ({
  id: r.id,
  key: r.key,
  title: r.title,
  statusName: r.status.name,
  statusColor: r.status.color,
  category: r.status.category,
});

export function useDocTickets(
  workspaceId: string | null,
  documentId: string,
  canCreate: boolean,
): { host: TicketHost | undefined; dialog: ReactNode } {
  const t = useT();
  const toast = useToast();
  const [pending, setPending] = useState<{
    title: string;
    resolve(h: TicketHit | null): void;
  } | null>(null);
  const [projects, setProjects] = useState<ProjectDTO[] | null>(null);
  const [ctx, setCtx] = useState<CreateContext | null>(null);
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    setProjects(null);
    if (workspaceId)
      void api.projects(workspaceId).then(
        (p) => setProjects(p.filter((x) => !x.archivedAt)),
        () => setProjects([]),
      );
  }, [workspaceId]);

  const loadCtx = async (projectId: string) => {
    const [meta, list] = await Promise.all([api.project(projectId), api.list(projectId)]);
    setCtx({ ...meta, tickets: list.tickets });
    try {
      localStorage.setItem(LAST_PROJECT, projectId);
    } catch {
      /* private mode */
    }
  };

  const host = useMemo<TicketHost | undefined>(() => {
    if (!workspaceId) return undefined;
    return {
      search: async (q) => {
        const found = await api.search({
          workspaceId,
          filter: q ? { q } : { assignees: ['me'], categories: ['todo', 'doing'] },
          limit: 8,
        });
        if (!found.length) return [];
        const refs = await api.refs(found.map((x) => x.id));
        const byId = new Map(refs.map((r) => [r.id, r]));
        return found
          .map((x) => byId.get(x.id))
          .filter((x): x is TicketRefDTO => !!x)
          .map(hit);
      },
      resolve: async (ids) => (await api.refs(ids)).map(hit),
      create: canCreate
        ? (title) =>
            new Promise<TicketHit | null>((resolve) => {
              setPending({ title, resolve });
            })
        : undefined,
      labels: {
        heading: tRef.current('tk.doc.menu'),
        empty: tRef.current('tk.doc.menuEmpty'),
        create: (title) => tRef.current('tk.doc.menuCreate', { title }),
        fromSelection: tRef.current('tk.doc.fromSelection'),
      },
    };
  }, [workspaceId, canCreate]);

  // Opening the dialog: pick the last used project of this space, or the first one.
  useEffect(() => {
    if (!pending || !projects) return;
    const editable = projects.filter((p) => p.canEdit);
    if (!editable.length) {
      toast(t('tk.doc.noProject'));
      pending.resolve(null);
      setPending(null);
      return;
    }
    let last: string | null = null;
    try {
      last = localStorage.getItem(LAST_PROJECT);
    } catch {
      /* private mode */
    }
    const p = editable.find((x) => x.id === last) ?? editable[0]!;
    if (ctx?.project.id !== p.id) loadCtx(p.id).catch((e) => toast(errMsg(e)));
  }, [pending, projects]);

  const close = (h: TicketHit | null) => {
    pending?.resolve(h);
    setPending(null);
  };

  const dialog =
    pending && ctx && projects ? (
      <CreateTicketDialog
        key={ctx.project.id}
        ctx={ctx}
        projects={projects}
        onSwitchProject={(id) => void loadCtx(id).catch((e) => toast(errMsg(e)))}
        defaults={{ title: pending.title, type: 'task' }}
        documentId={documentId}
        onCreated={(x) => {
          const st = ctx.project.statuses.find((s) => s.id === x.statusId);
          toast(t('tk.created', { key: x.key }));
          close({
            id: x.id,
            key: x.key,
            title: x.title,
            statusName: st?.name ?? '',
            statusColor: st?.color ?? '#9aa294',
            category: st?.category ?? 'todo',
          });
        }}
        onClose={() => close(null)}
      />
    ) : null;

  return { host, dialog };
}
