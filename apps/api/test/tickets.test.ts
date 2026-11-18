import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, signup, type App } from './helpers.js';

let app: App;
let pool: { end: () => Promise<void> };

beforeAll(async () => {
  const s = await setup();
  app = s.app;
  pool = s.pool;
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

type Client = Awaited<ReturnType<typeof signup>>['c'];
const tokenOf = (url: string) => url.split('/invite/')[1]!;

async function teamWith(
  owner: Client,
  members: { c: Client; user: { email: string } }[],
  role: 'editor' | 'viewer',
) {
  const ws = (await owner.post('/api/workspaces', { name: 'Team' })).json.workspace.id as string;
  for (const m of members) {
    const r = await owner.post(`/api/workspaces/${ws}/invites`, { emails: [m.user.email], role });
    await m.c.post(`/api/invites/${tokenOf(r.json.invites[0].url)}/accept`);
  }
  return ws;
}

async function project(c: Client, ws: string, key = 'BEE', template = 'scrum') {
  const r = await c.post(`/api/workspaces/${ws}/projects`, { name: 'Bee', key, template });
  expect(r.status).toBe(201);
  return r.json.project as {
    id: string;
    key: string;
    statuses: { id: string; name: string; category: string }[];
    usesSprints: boolean;
  };
}

describe('ticket projects', () => {
  it('creates a project from a template, numbers tickets and enforces the hierarchy', async () => {
    const own = await signup(app, 'tkown');
    const p = await project(own.c, own.workspace.id);
    expect(p.statuses.map((s) => s.category)).toEqual(['todo', 'doing', 'doing', 'done']);
    expect(p.usesSprints).toBe(true);
    // keys are unique in a workspace
    const dup = await own.c.post(`/api/workspaces/${own.workspace.id}/projects`, {
      name: 'X',
      key: 'BEE',
    });
    expect(dup.status).toBe(409);

    const epic = (
      await own.c.post(`/api/projects/${p.id}/tickets`, { type: 'epic', title: 'Collab' })
    ).json.ticket;
    expect(epic.key).toBe('BEE-1');
    const story = (
      await own.c.post(`/api/projects/${p.id}/tickets`, {
        type: 'story',
        title: 'Board',
        parentId: epic.id,
        storyPoints: 5,
      })
    ).json.ticket;
    expect(story).toMatchObject({ key: 'BEE-2', parentId: epic.id, statusId: p.statuses[0]!.id });
    // a subtask needs a story/task/bug parent
    expect(
      (await own.c.post(`/api/projects/${p.id}/tickets`, { type: 'subtask', title: 'x' })).status,
    ).toBe(400);
    expect(
      (
        await own.c.post(`/api/projects/${p.id}/tickets`, {
          type: 'subtask',
          title: 'x',
          parentId: epic.id,
        })
      ).json.error.code,
    ).toBe('bad_parent');
    const sub = (
      await own.c.post(`/api/projects/${p.id}/tickets`, {
        type: 'subtask',
        title: 'API',
        parentId: story.id,
      })
    ).json.ticket;
    expect(sub.key).toBe('BEE-3');
    // an epic cannot become a story while it has stories under it
    expect((await own.c.patch(`/api/tickets/${epic.id}`, { type: 'story' })).status).toBe(400);

    const detail = (await own.c.get(`/api/tickets/${story.id}`)).json.ticket;
    expect(detail.parent.key).toBe('BEE-1');
    expect(detail.children.map((c: { key: string }) => c.key)).toEqual(['BEE-3']);
    expect(detail.watching).toBe(true);
    expect(detail.events[0].field).toBe('created');
    const byKey = await own.c.get(`/api/workspaces/${own.workspace.id}/tickets/bee-2`);
    expect(byKey.json.ticket.id).toBe(story.id);
  });

  it('status changes: resolution, completedAt, restricted transitions', async () => {
    const own = await signup(app, 'tkst');
    const p = await project(own.c, own.workspace.id, 'ST');
    const [todo, doing, review, done] = p.statuses;
    const t = (await own.c.post(`/api/projects/${p.id}/tickets`, { title: 'Fix it' })).json.ticket;
    let r = await own.c.patch(`/api/tickets/${t.id}`, { statusId: done!.id });
    expect(r.json.ticket).toMatchObject({ resolution: 'done' });
    expect(r.json.ticket.completedAt).toBeTruthy();
    r = await own.c.patch(`/api/tickets/${t.id}`, { statusId: todo!.id });
    expect(r.json.ticket).toMatchObject({ resolution: null, completedAt: null });

    await own.c.patch(`/api/projects/${p.id}/statuses/${done!.id}`, { requireResolution: true });
    r = await own.c.patch(`/api/tickets/${t.id}`, { statusId: done!.id });
    expect(r.json.error.code).toBe('resolution_required');
    r = await own.c.patch(`/api/tickets/${t.id}`, { statusId: done!.id, resolution: 'wont_do' });
    expect(r.json.ticket.resolution).toBe('wont_do');

    await own.c.put(`/api/projects/${p.id}/transitions`, {
      transitions: [
        { fromId: todo!.id, toId: doing!.id },
        { fromId: doing!.id, toId: review!.id },
        { fromId: done!.id, toId: todo!.id },
      ],
    });
    await own.c.patch(`/api/projects/${p.id}`, { restrictTransitions: true });
    expect((await own.c.patch(`/api/tickets/${t.id}`, { statusId: todo!.id })).status).toBe(200);
    expect(
      (await own.c.patch(`/api/tickets/${t.id}`, { statusId: review!.id })).json.error.code,
    ).toBe('transition_not_allowed');

    // deleting a status moves its tickets
    const extra = (
      await own.c.post(`/api/projects/${p.id}/statuses`, { name: 'QA', category: 'doing' })
    ).json.status;
    await own.c.patch(`/api/projects/${p.id}`, { restrictTransitions: false });
    await own.c.patch(`/api/tickets/${t.id}`, { statusId: extra.id });
    await own.c.del(`/api/projects/${p.id}/statuses/${extra.id}?moveTo=${doing!.id}`);
    expect((await own.c.get(`/api/tickets/${t.id}`)).json.ticket.statusId).toBe(doing!.id);
  });

  it('labels, custom fields, bulk edit, search and saved views', async () => {
    const own = await signup(app, 'tkfl');
    const ws = own.workspace.id;
    const p = await project(own.c, ws, 'FL', 'kanban');
    const label = (await own.c.post(`/api/projects/${p.id}/labels`, { name: 'Frontend' })).json
      .label;
    const field = (
      await own.c.post(`/api/projects/${p.id}/fields`, {
        name: 'Customer',
        kind: 'select',
        options: [{ label: 'Acme' }, { label: 'Globex' }],
      })
    ).json.field;
    const acme = field.options[0].id;
    const a = (
      await own.c.post(`/api/projects/${p.id}/tickets`, {
        title: 'A',
        labelIds: [label.id],
        fields: { [field.id]: acme },
        priority: 'urgent',
        assigneeId: own.user.id,
      })
    ).json.ticket;
    expect(a.fields[field.id]).toBe(acme);
    expect(
      (
        await own.c.post(`/api/projects/${p.id}/tickets`, {
          title: 'bad',
          fields: { [field.id]: 'nope' },
        })
      ).status,
    ).toBe(400);
    const b = (await own.c.post(`/api/projects/${p.id}/tickets`, { title: 'B' })).json.ticket;

    const bulk = await own.c.post('/api/tickets/bulk', {
      ids: [a.id, b.id],
      patch: { priority: 'low', storyPoints: 3 },
    });
    expect(bulk.json.updated.map((t: { priority: string }) => t.priority)).toEqual(['low', 'low']);

    const found = await own.c.post('/api/tickets/search', {
      workspaceId: ws,
      filter: { labelIds: [label.id] },
    });
    expect(found.json.tickets.map((t: { id: string }) => t.id)).toEqual([a.id]);
    const byField = await own.c.post('/api/tickets/search', {
      workspaceId: ws,
      filter: { fields: { [field.id]: acme } },
    });
    expect(byField.json.tickets).toHaveLength(1);
    const mine = await own.c.get(`/api/my-tickets?workspaceId=${ws}`);
    expect(mine.json.tickets.map((t: { id: string }) => t.id)).toEqual([a.id]);

    // removing the label removes it from tickets
    await own.c.del(`/api/projects/${p.id}/labels/${label.id}`);
    expect((await own.c.get(`/api/tickets/${a.id}`)).json.ticket.labelIds).toEqual([]);

    const v = await own.c.post(`/api/workspaces/${ws}/views`, {
      name: 'Urgent',
      projectId: p.id,
      config: { view: 'list', filter: { priorities: ['urgent'] }, groupBy: 'status' },
    });
    expect(v.status).toBe(201);
    expect((await own.c.get(`/api/workspaces/${ws}/views`)).json.views).toHaveLength(1);

    const del = await own.c.post('/api/tickets/bulk', { ids: [b.id], delete: true });
    expect(del.json.deleted).toEqual([b.id]);
    const list = await own.c.get(`/api/projects/${p.id}/tickets`);
    expect(list.json.tickets.map((t: { id: string }) => t.id)).toEqual([a.id]);
    const since = await own.c.get(
      `/api/projects/${p.id}/tickets?since=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`,
    );
    expect(since.json.deleted).toContain(b.id);
  });

  it('sprints: plan, start, burndown, complete and velocity', async () => {
    const own = await signup(app, 'tksp');
    const p = await project(own.c, own.workspace.id, 'SP');
    const done = p.statuses.find((s) => s.category === 'done')!;
    const sprints = (await own.c.get(`/api/projects/${p.id}/sprints`)).json.sprints;
    const s1 = sprints[0];
    expect(s1.state).toBe('planned');
    const t1 = (
      await own.c.post(`/api/projects/${p.id}/tickets`, {
        type: 'story',
        title: 'One',
        storyPoints: 5,
        sprintId: s1.id,
      })
    ).json.ticket;
    const t2 = (
      await own.c.post(`/api/projects/${p.id}/tickets`, {
        type: 'story',
        title: 'Two',
        storyPoints: 3,
        sprintId: s1.id,
      })
    ).json.ticket;
    const sub = (
      await own.c.post(`/api/projects/${p.id}/tickets`, {
        type: 'subtask',
        title: 'Two.a',
        parentId: t2.id,
      })
    ).json.ticket;
    expect(sub.sprintId).toBe(s1.id);
    // epics are never planned
    const epic = (
      await own.c.post(`/api/projects/${p.id}/tickets`, {
        type: 'epic',
        title: 'E',
        sprintId: s1.id,
      })
    ).json.ticket;
    expect(epic.sprintId).toBeNull();

    const started = await own.c.post(`/api/sprints/${s1.id}/start`, {});
    expect(started.json.sprint).toMatchObject({ state: 'active', summary: { committedPoints: 8 } });
    const s2 = (await own.c.post(`/api/projects/${p.id}/sprints`, {})).json.sprint;
    expect((await own.c.post(`/api/sprints/${s2.id}/start`, {})).json.error.code).toBe(
      'sprint_active',
    );

    await own.c.patch(`/api/tickets/${t1.id}`, { statusId: done.id });
    const bd = (await own.c.get(`/api/sprints/${s1.id}/burndown`)).json;
    expect(bd).toMatchObject({ scope: 8, remaining: 3, added: 0 });
    expect(bd.days.at(-1)).toMatchObject({ remaining: 3, completed: 5 });

    const closed = await own.c.post(`/api/sprints/${s1.id}/complete`, { moveTo: s2.id });
    expect(closed.json).toMatchObject({ moved: 2, movedTo: s2.id });
    expect(closed.json.sprint.summary).toMatchObject({ committedPoints: 8, completedPoints: 5 });
    // the unfinished story and its subtask moved together
    expect((await own.c.get(`/api/tickets/${sub.id}`)).json.ticket.sprintId).toBe(s2.id);
    const vel = (await own.c.get(`/api/projects/${p.id}/velocity`)).json;
    expect(vel).toMatchObject({ average: 5, sprints: [{ committed: 8, completed: 5 }] });
    const wl = (await own.c.get(`/api/projects/${p.id}/workload`)).json.rows;
    expect(wl[0]).toMatchObject({ done: 5, todo: 3 });
  });

  it('team roles, comments, mentions, watchers, links and notifications', async () => {
    const own = await signup(app, 'tkto');
    const ed = await signup(app, 'tkted');
    const vw = await signup(app, 'tktvw');
    const outsider = await signup(app, 'tktout');
    const ws = await teamWith(own.c, [ed], 'editor');
    {
      const r = await own.c.post(`/api/workspaces/${ws}/invites`, {
        emails: [vw.user.email],
        role: 'viewer',
      });
      await vw.c.post(`/api/invites/${tokenOf(r.json.invites[0].url)}/accept`);
    }
    const p = await project(own.c, ws, 'TM');
    // viewers can't create projects or tickets, outsiders can't see them
    expect(
      (await vw.c.post(`/api/workspaces/${ws}/projects`, { name: 'X', key: 'XX' })).status,
    ).toBe(403);
    expect((await vw.c.post(`/api/projects/${p.id}/tickets`, { title: 'x' })).status).toBe(403);
    expect((await outsider.c.get(`/api/projects/${p.id}`)).status).toBe(404);
    // editors can't change settings unless they lead the project
    expect((await ed.c.patch(`/api/projects/${p.id}`, { name: 'Y' })).status).toBe(403);

    const t = (
      await own.c.post(`/api/projects/${p.id}/tickets`, {
        title: 'Ship it',
        assigneeId: ed.user.id,
      })
    ).json.ticket;
    let inbox = (await ed.c.get('/api/notifications')).json.notifications;
    expect(inbox[0]).toMatchObject({
      kind: 'ticket_assigned',
      ticket: { key: 'TM-1', title: 'Ship it' },
    });

    // viewers comment; mentions and watchers are notified
    const c = await vw.c.post(`/api/tickets/${t.id}/comments`, { body: 'Hi @tkto, any news?' });
    expect(c.status).toBe(201);
    const ownInbox = (await own.c.get('/api/notifications')).json.notifications;
    expect(ownInbox[0]).toMatchObject({ kind: 'ticket_mention' });
    inbox = (await ed.c.get('/api/notifications')).json.notifications;
    expect(inbox[0]).toMatchObject({ kind: 'ticket_comment', detail: 'Hi @tkto, any news?' });
    // only its author edits a comment
    expect(
      (await own.c.patch(`/api/ticket-comments/${c.json.comment.id}`, { body: 'x' })).status,
    ).toBe(403);

    await ed.c.patch(`/api/tickets/${t.id}`, { statusId: p.statuses[1]!.id });
    expect((await own.c.get('/api/notifications')).json.notifications[0]).toMatchObject({
      kind: 'ticket_update',
    });

    const blocker = (
      await own.c.post(`/api/projects/${p.id}/tickets`, { title: 'Blocker', type: 'bug' })
    ).json.ticket;
    expect(
      (await ed.c.post(`/api/tickets/${blocker.id}/links`, { kind: 'blocks', targetKey: 'TM-1' }))
        .status,
    ).toBe(201);
    const after = (await ed.c.get(`/api/tickets/${t.id}`)).json.ticket;
    expect(after.blockedBy).toEqual(['TM-2']);
    expect(after.links[0]).toMatchObject({
      kind: 'blocks',
      direction: 'in',
      ticket: { key: 'TM-2' },
    });

    // leaving the team hides the ticket notifications
    await own.c.del(`/api/workspaces/${ws}/members/${ed.user.id}`);
    inbox = (await ed.c.get('/api/notifications')).json.notifications;
    expect(inbox.some((n: { kind: string }) => n.kind.startsWith('ticket_'))).toBe(false);
  });
});

describe('ticket MCP tools', () => {
  const callTool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
    const r = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      payload: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    expect(r.statusCode).toBe(200);
    const res = r.json().result as { content: { text: string }[]; isError?: boolean };
    return { text: res.content[0]!.text, isError: !!res.isError };
  };

  it('creates, finds, updates and reads tickets by key and names', async () => {
    const own = await signup(app, 'tkmcp');
    const p = await project(own.c, own.workspace.id, 'MC');
    await own.c.post(`/api/projects/${p.id}/fields`, {
      name: 'Customer',
      kind: 'select',
      options: [{ label: 'Acme' }],
    });
    const token = (await own.c.post('/api/tokens', { name: 't' })).json.secret as string;

    const list = await callTool(token, 'list_projects');
    expect(list.text).toContain('"key": "MC"');

    const epic = await callTool(token, 'create_ticket', {
      project: 'mc',
      type: 'epic',
      title: 'Launch',
    });
    expect(epic.text).toContain('Created MC-1');
    const many = await callTool(token, 'create_tickets', {
      project: 'MC',
      items: [
        {
          title: 'Landing page',
          type: 'story',
          parent: 'MC-1',
          assignee: 'me',
          labels: ['web'],
          storyPoints: 3,
          fields: { Customer: 'Acme' },
        },
        { title: 'Pricing', type: 'story', parent: 'MC-1', sprint: 'MC Sprint 1' },
        { title: 'Broken', type: 'subtask' },
      ],
    });
    expect(many.text).toContain('MC-2 Landing page');
    expect(many.text).toContain('MC-3 Pricing');
    expect(many.text).toContain('FAILED “Broken”');

    const found = await callTool(token, 'search_tickets', {
      project: 'MC',
      assignee: 'me',
      labels: ['web'],
    });
    expect(found.text).toContain('MC-2');
    expect(found.text).not.toContain('MC-3');
    const byEpic = await callTool(token, 'search_tickets', { epic: 'MC-1' });
    expect(byEpic.text.split('\n')).toHaveLength(2);

    const up = await callTool(token, 'update_ticket', {
      ticket: 'MC-2',
      status: 'In progress',
      priority: 'high',
    });
    expect(up.text).toContain('进行中, high');
    const bad = await callTool(token, 'update_ticket', { ticket: 'MC-2', status: 'Nope' });
    expect(bad.isError).toBe(true);
    await callTool(token, 'comment_on_ticket', { ticket: 'MC-2', body: 'Looks good' });
    await callTool(token, 'link_tickets', { ticket: 'MC-3', kind: 'blocks', target: 'MC-2' });

    const read = await callTool(token, 'read_ticket', { ticket: 'mc-2' });
    expect(read.text).toContain('# MC-2 Landing page');
    expect(read.text).toContain('Customer: Acme');
    expect(read.text).toContain('Parent: MC-1 Launch');
    expect(read.text).toContain('is blocked by MC-3');
    expect(read.text).toContain('Looks good');
    const sprints = await callTool(token, 'list_sprints', { project: 'MC' });
    expect(sprints.text).toContain('MC Sprint 1 [planned]');
  });
});

describe('documents and tickets', () => {
  it('records tickets a document links to, and the state store keeps them in sync', async () => {
    const own = await signup(app, 'tkdoc');
    const p = await project(own.c, own.workspace.id, 'DC');
    const t = (await own.c.post(`/api/projects/${p.id}/tickets`, { title: 'Docs' })).json.ticket;
    const md = `# Notes\n\nWorking on [${t.key} Docs](/t/${t.id}) this week.\n`;
    const doc = (
      await own.c.post('/api/documents', { workspaceId: own.workspace.id, markdown: md })
    ).json.document;
    const refs = (await own.c.get(`/api/documents/${doc.id}/tickets`)).json.tickets;
    expect(refs.map((r: { key: string }) => r.key)).toEqual(['DC-1']);
    const detail = (await own.c.get(`/api/tickets/${t.id}`)).json.ticket;
    expect(detail.documents).toEqual([expect.objectContaining({ id: doc.id, source: 'mention' })]);
    // a manual link sits next to the mention
    await own.c.post(`/api/tickets/${t.id}/documents`, { documentId: doc.id });
    expect((await own.c.get(`/api/tickets/${t.id}`)).json.ticket.documents).toHaveLength(1);
    const live = (await own.c.post('/api/tickets/refs', { ids: [t.id] })).json.tickets;
    expect(live[0]).toMatchObject({ key: 'DC-1', status: { category: 'todo' } });
  });
});

describe('CSV import and export', () => {
  it('imports a Jira export with parents, sprints and labels, and exports it back', async () => {
    const own = await signup(app, 'tkcsv');
    const p = await project(own.c, own.workspace.id, 'CV');
    const csv = [
      'Summary,Issue key,Issue Type,Status,Priority,Assignee,Parent,Sprint,Labels,Labels,Custom field (Story Points),Due date,Description',
      'Login works,JRA-2,Story,In Progress,High,tkcsv@example.com,JRA-1,Sprint 7,auth,web,5,21/Nov/26 3:45 PM,"Multi, line\n""quoted"""',
      'Accounts,JRA-1,Epic,To Do,Medium,,,,,,,,',
      'Button,JRA-3,Sub-task,Done,Lowest,,JRA-2,,,,,,',
      ',JRA-4,Task,,,,,,,,,,',
    ].join('\n');
    const r = await own.c.post(`/api/projects/${p.id}/import`, { csv });
    expect(r.json).toMatchObject({ created: 3, errorCount: 1 });
    const list = (await own.c.get(`/api/projects/${p.id}/tickets`)).json.tickets as {
      title: string;
      type: string;
      parentId: string | null;
      id: string;
      priority: string;
      storyPoints: number | null;
      dueDate: string | null;
      description: string;
      labelIds: string[];
      sprintId: string | null;
      statusId: string;
      assignee: { id: string } | null;
    }[];
    const by = (t: string) => list.find((x) => x.title === t)!;
    expect(by('Accounts').type).toBe('epic');
    expect(by('Login works')).toMatchObject({
      type: 'story',
      parentId: by('Accounts').id,
      priority: 'high',
      storyPoints: 5,
      dueDate: '2026-11-21',
      description: 'Multi, line\n"quoted"',
    });
    expect(by('Login works').labelIds).toHaveLength(2);
    expect(by('Login works').assignee?.id).toBe(own.user.id);
    expect(by('Login works').statusId).toBe(p.statuses.find((s) => s.category === 'doing')!.id);
    expect(by('Button')).toMatchObject({
      type: 'subtask',
      parentId: by('Login works').id,
      priority: 'low',
      sprintId: by('Login works').sprintId,
    });
    expect(by('Button').statusId).toBe(p.statuses.find((s) => s.category === 'done')!.id);
    const sprints = (await own.c.get(`/api/projects/${p.id}/sprints`)).json.sprints;
    expect(sprints.map((s: { name: string }) => s.name)).toContain('Sprint 7');

    const out = await own.c.get(`/api/projects/${p.id}/export.csv`);
    expect(out.res.headers['content-type']).toContain('text/csv');
    const body = out.res.body as string;
    expect(body).toContain('CV-2,story,Login works');
    expect(body).toContain('"Multi, line\n""quoted"""');
    // Bee's own export imports back.
    const p2 = await project(own.c, own.workspace.id, 'CW');
    const again = await own.c.post(`/api/projects/${p2.id}/import`, { csv: body });
    expect(again.json).toMatchObject({ created: 3, errorCount: 0 });
  });
});
