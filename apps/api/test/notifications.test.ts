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

describe('mentions and notifications', () => {
  it('notifies mentioned readers and thread participants, not the author', async () => {
    const ann = await signup(app, 'ann');
    const ben = await signup(app, 'ben');
    const cat = await signup(app, 'cat');
    const ws = ann.workspace.id;
    for (const email of ['ben@example.com', 'cat@example.com'])
      await ann.c.post(`/api/workspaces/${ws}/members`, { email, role: 'member' });
    const doc = (await ann.c.post('/api/documents', { workspaceId: ws, title: 'Plan' })).json
      .document;

    // Only readers can be mentioned: nobody else until the doc is shared.
    let m = (await ann.c.get(`/api/documents/${doc.id}/mentionable`)).json.users;
    expect(m.map((u: { name: string }) => u.name)).toEqual(['ann']);
    await ann.c.post(`/api/documents/${doc.id}/grants`, {
      email: 'ben@example.com',
      role: 'commenter',
    });
    m = (await ann.c.get(`/api/documents/${doc.id}/mentionable?q=be`)).json.users;
    expect(m.map((u: { name: string }) => u.name)).toEqual(['ben']);

    // The share itself is a notification.
    let inbox = (await ben.c.get('/api/notifications')).json;
    expect(inbox.unread).toBe(1);
    expect(inbox.notifications[0]).toMatchObject({
      kind: 'share',
      detail: 'commenter',
      document: { id: doc.id },
    });

    // cat cannot read the doc, so mentioning her does nothing.
    const t = (
      await ann.c.post(`/api/documents/${doc.id}/threads`, {
        anchor: null,
        body: 'hey @ben and @cat',
      })
    ).json.thread;
    inbox = (await ben.c.get('/api/notifications?unread=1')).json;
    expect(inbox.unread).toBe(2);
    expect(inbox.notifications[0]).toMatchObject({
      kind: 'mention',
      threadId: t.id,
      actor: { name: 'ann' },
    });
    expect((await cat.c.get('/api/notifications/unread')).json.unread).toBe(0);

    // A reply notifies the other participants.
    await ben.c.post(`/api/threads/${t.id}/comments`, { body: 'on it' });
    inbox = (await ann.c.get('/api/notifications')).json;
    expect(inbox.notifications.map((n: { kind: string }) => n.kind)).toEqual(['reply']);
    expect((await ben.c.get('/api/notifications/unread')).json.unread).toBe(2);

    const r = await ben.c.post('/api/notifications/read', { ids: [inbox.notifications[0].id] });
    expect(r.json.unread).toBe(2); // not ben's notification
    expect((await ben.c.post('/api/notifications/read', { all: true })).json.unread).toBe(0);
  });
});

describe('templates', () => {
  it('saves a doc as a template, lists and deletes it', async () => {
    const dee = await signup(app, 'dee');
    const eve = await signup(app, 'eve');
    const ws = dee.workspace.id;
    await dee.c.post(`/api/workspaces/${ws}/members`, { email: 'eve@example.com', role: 'member' });
    const doc = (
      await dee.c.post('/api/documents', {
        workspaceId: ws,
        markdown: '# Weekly\n\n## Done\n\n- one',
      })
    ).json.document;
    const t = (await dee.c.post(`/api/documents/${doc.id}/template`, {})).json.template;
    expect(t).toMatchObject({ title: 'Weekly', canDelete: true });
    expect(t.markdown).toContain('## Done');

    const list = (await eve.c.get(`/api/workspaces/${ws}/templates`)).json.templates;
    expect(list).toHaveLength(1);
    expect(list[0].canDelete).toBe(false);
    expect((await eve.c.del(`/api/templates/${t.id}`)).status).toBe(403);
    expect((await dee.c.del(`/api/templates/${t.id}`)).status).toBe(200);
    expect((await eve.c.get(`/api/workspaces/${ws}/templates`)).json.templates).toHaveLength(0);
  });
});

describe('access requests', () => {
  it('asks the editors, who grant from the notification', async () => {
    const fay = await signup(app, 'fay');
    const gus = await signup(app, 'gus');
    const hal = await signup(app, 'hal');
    const ws = fay.workspace.id;
    await fay.c.post(`/api/workspaces/${ws}/members`, { email: 'gus@example.com', role: 'member' });
    const doc = (await fay.c.post('/api/documents', { workspaceId: ws, title: 'Secret' })).json
      .document;
    await fay.c.post(`/api/documents/${doc.id}/grants`, {
      email: 'gus@example.com',
      role: 'editor',
    });

    expect((await hal.c.get(`/api/documents/${doc.id}`)).status).toBe(404);
    const r = await hal.c.post(`/api/documents/${doc.id}/access-requests`, {
      role: 'editor',
      message: 'please',
    });
    expect(r.status).toBe(201);
    expect(r.json.request).toMatchObject({ status: 'pending', role: 'editor' });
    // Asking again right away does not notify twice.
    await hal.c.post(`/api/documents/${doc.id}/access-requests`, { role: 'commenter' });

    for (const who of [fay, gus]) {
      const n = (await who.c.get('/api/notifications?unread=1')).json.notifications.filter(
        (x: { kind: string }) => x.kind === 'access_request',
      );
      expect(n).toHaveLength(1);
      expect(n[0].request).toMatchObject({ role: 'commenter', user: { email: 'hal@example.com' } });
    }
    const reqId = r.json.request.id;
    expect((await hal.c.post(`/api/access-requests/${reqId}`, { action: 'decline' })).status).toBe(
      404,
    );
    const g = await gus.c.post(`/api/access-requests/${reqId}`, {
      action: 'grant',
      role: 'viewer',
    });
    expect(g.json.request).toMatchObject({ status: 'granted', grantedRole: 'viewer' });
    expect((await hal.c.get(`/api/documents/${doc.id}`)).json.document.role).toBe('viewer');
    // Handled for fay too; hal hears back.
    const fayN = (await fay.c.get('/api/notifications')).json.notifications.find(
      (x: { kind: string }) => x.kind === 'access_request',
    );
    expect(fayN).toMatchObject({ read: true, request: { status: 'granted' } });
    expect((await hal.c.get('/api/notifications')).json.notifications[0]).toMatchObject({
      kind: 'share',
      detail: 'viewer',
    });
    expect(
      (await hal.c.post(`/api/documents/${doc.id}/access-requests`, { role: 'editor' })).status,
    ).toBe(409);
    expect(
      (await hal.c.get(`/api/documents/${doc.id}/access-requests/mine`)).json.request.status,
    ).toBe('granted');
  });
});
