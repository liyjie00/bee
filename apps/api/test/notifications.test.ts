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
      await ann.c.post(`/api/workspaces/${ws}/members`, { email, role: 'editor' });
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
    await dee.c.post(`/api/workspaces/${ws}/members`, { email: 'eve@example.com', role: 'editor' });
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
    await fay.c.post(`/api/workspaces/${ws}/members`, { email: 'gus@example.com', role: 'editor' });
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

describe('email digests', () => {
  it('sends one email per person and document, skipping read ones and opted-out people', async () => {
    const nodemailer = (await import('nodemailer')).default;
    const { setMailer, sendEmailDigests } = await import('../src/lib/delivery.js');
    const db = app.db;
    const sent: { to: string; subject: string }[] = [];
    const t = nodemailer.createTransport({ jsonTransport: true });
    const send = t.sendMail.bind(t);
    t.sendMail = (async (m: { to: string; subject: string }) => {
      sent.push({ to: m.to, subject: m.subject });
      return send(m);
    }) as never;
    setMailer(t);
    try {
      const ivy = await signup(app, 'ivy');
      const jon = await signup(app, 'jon');
      const kim = await signup(app, 'kim');
      const ws = ivy.workspace.id;
      const doc = (await ivy.c.post('/api/documents', { workspaceId: ws, title: 'Notes' })).json
        .document;
      for (const email of ['jon@example.com', 'kim@example.com'])
        await ivy.c.post(`/api/documents/${doc.id}/grants`, { email, role: 'commenter' });
      await kim.c.patch('/api/auth/me', { prefs: { emailNotifications: false } });
      await ivy.c.post(`/api/documents/${doc.id}/threads`, { anchor: null, body: '@jon @kim one' });
      await ivy.c.post(`/api/documents/${doc.id}/threads`, { anchor: null, body: '@jon two' });
      // Pretend they are old enough to send.
      await db.execute(
        (await import('drizzle-orm'))
          .sql`update notifications set created_at = now() - interval '15 minutes' where emailed_at is null`,
      );
      await sendEmailDigests(db);
      const forJon = sent.filter((m) => m.to === 'jon@example.com');
      expect(forJon).toHaveLength(1); // the share and two mentions, one document
      expect(forJon[0]!.subject).toContain('Notes');
      expect(sent.some((m) => m.to === 'kim@example.com')).toBe(false);
      sent.length = 0;
      await sendEmailDigests(db);
      expect(sent).toHaveLength(0);
    } finally {
      setMailer(null);
    }
  });
});

describe('stars', () => {
  it('stars readable docs and lists them newest first', async () => {
    const lee = await signup(app, 'lee');
    const ws = lee.workspace.id;
    const a = (await lee.c.post('/api/documents', { workspaceId: ws, title: 'A' })).json.document;
    const b = (await lee.c.post('/api/documents', { workspaceId: ws, title: 'B' })).json.document;
    const put = (u: string) =>
      app.inject({ method: 'PUT', url: u, headers: { cookie: lee.c.cookie } });
    await put(`/api/documents/${a.id}/star`);
    await put(`/api/documents/${b.id}/star`);
    await put(`/api/documents/${b.id}/star`);
    let list = (await lee.c.get(`/api/workspaces/${ws}/starred`)).json.documents;
    expect(list.map((d: { title: string }) => d.title)).toEqual(['B', 'A']);
    await lee.c.del(`/api/documents/${b.id}/star`);
    list = (await lee.c.get(`/api/workspaces/${ws}/starred`)).json.documents;
    expect(list.map((d: { title: string }) => d.title)).toEqual(['A']);
    const other = await signup(app, 'mo');
    expect(
      (
        await app.inject({
          method: 'PUT',
          url: `/api/documents/${a.id}/star`,
          headers: { cookie: other.c.cookie },
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe('link previews', () => {
  it('gives the title and the section heading of a block', async () => {
    const { yUpdateToJSON } = await import('@bee/editor/markdown');
    const nat = await signup(app, 'nat');
    const doc = (
      await nat.c.post('/api/documents', {
        workspaceId: nat.workspace.id,
        title: 'Plan',
        markdown: 'intro\n\n## Milestones\n\nfirst\n\n## Risks\n\nsecond',
      })
    ).json.document;
    const state = await app.inject({
      method: 'GET',
      url: `/api/documents/${doc.id}/state`,
      headers: { cookie: nat.c.cookie },
    });
    const blocks = yUpdateToJSON(new Uint8Array(state.rawPayload)).content!;
    const first = blocks.find((b) => b.content?.[0]?.text === 'first')!.attrs!.blockId as string;
    const r = (await nat.c.get(`/api/documents/${doc.id}/link-preview?block=${first}`)).json;
    expect(r).toMatchObject({ title: 'Plan', section: 'Milestones', type: 'doc' });
    expect((await nat.c.get(`/api/documents/${doc.id}/link-preview`)).json.section).toBeNull();
    const out = await signup(app, 'oz');
    expect((await out.c.get(`/api/documents/${doc.id}/link-preview`)).status).toBe(404);
  });
});
