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

/** Captures emails sent while `fn` runs. */
async function withMail<T>(fn: (sent: { to: string; text: string }[]) => Promise<T>): Promise<T> {
  const nodemailer = (await import('nodemailer')).default;
  const { setMailer } = await import('../src/lib/delivery.js');
  const sent: { to: string; text: string }[] = [];
  const t = nodemailer.createTransport({ jsonTransport: true });
  const send = t.sendMail.bind(t);
  t.sendMail = (async (m: (typeof sent)[number]) => {
    sent.push(m);
    return send(m as never);
  }) as never;
  setMailer(t);
  try {
    return await fn(sent);
  } finally {
    setMailer(null);
  }
}

const tokenOf = (url: string) => url.split('/invite/')[1]!;

async function team(owner: Client, name: string) {
  const r = await owner.post('/api/workspaces', { name });
  expect(r.status).toBe(201);
  return r.json.workspace as { id: string; kind: string; role: string };
}

/** Adds an existing user to a team with a role, through an email invitation. */
async function join(owner: Client, wsId: string, who: { c: Client; user: { email: string } }, role: 'editor' | 'viewer') {
  const r = await owner.post(`/api/workspaces/${wsId}/invites`, { emails: [who.user.email], role });
  expect(r.status).toBe(201);
  const acc = await who.c.post(`/api/invites/${tokenOf(r.json.invites[0].url)}/accept`);
  expect(acc.status).toBe(200);
}

describe('team workspaces', () => {
  it('creates a team, invites by email, and accepts only with the invited account', async () => {
    const own = await signup(app, 'tmown');
    const ed = await signup(app, 'tmed');
    const other = await signup(app, 'tmother');
    await withMail(async (sent) => {
      const r = await own.c.post('/api/workspaces', {
        name: 'Acme',
        color: '#3b7dd8',
        emails: ['tmed@example.com', 'new@example.com'],
      });
      expect(r.status).toBe(201);
      expect(r.json.workspace).toMatchObject({ kind: 'team', role: 'owner', color: '#3b7dd8' });
      expect(sent.map((m) => m.to).sort()).toEqual(['new@example.com', 'tmed@example.com']);
      const ws = r.json.workspace.id;
      const url = r.json.invites.find((i: { email: string }) => i.email === 'tmed@example.com').url;
      expect(sent.find((m) => m.to === 'tmed@example.com')!.text).toContain(url);

      // Ed sees the invitation in the inbox.
      const inbox = (await ed.c.get('/api/notifications')).json.notifications;
      expect(inbox[0]).toMatchObject({ kind: 'team_invite', workspace: { id: ws, kind: 'team' } });

      const preview = (await other.c.get(`/api/invites/${tokenOf(url)}`)).json.invite;
      expect(preview).toMatchObject({ role: 'editor', email: 'tmed@example.com', member: false });
      expect(preview.workspace).toMatchObject({ name: 'Acme', memberCount: 1 });

      const wrong = await other.c.post(`/api/invites/${tokenOf(url)}/accept`);
      expect(wrong.status).toBe(403);
      expect(wrong.json.error.code).toBe('wrong_account');
      const ok = await ed.c.post(`/api/invites/${tokenOf(url)}/accept`);
      expect(ok.json.workspace).toMatchObject({ id: ws, role: 'editor', memberCount: 2 });
      // used up
      expect((await ed.c.post(`/api/invites/${tokenOf(url)}/accept`)).status).toBe(404);

      const me = (await ed.c.get('/api/auth/me')).json.workspaces;
      expect(me.map((w: { kind: string }) => w.kind)).toEqual(['personal', 'team']);
      const pending = (await own.c.get(`/api/workspaces/${ws}/invites`)).json.invites;
      expect(pending.map((i: { email: string }) => i.email)).toEqual(['new@example.com']);
    });
  });

  it('join link gives its role; owners can reset or turn it off', async () => {
    const own = await signup(app, 'lkown');
    const guest = await signup(app, 'lkguest');
    const ws = (await team(own.c, 'Book club')).id;
    let link = (await own.c.patch(`/api/workspaces/${ws}/link`, { enabled: true, role: 'viewer' }))
      .json.link;
    expect(link.url).toContain('/invite/');
    const reset = (await own.c.post(`/api/workspaces/${ws}/link/reset`)).json.link;
    expect((await guest.c.get(`/api/invites/${tokenOf(link.url)}`)).status).toBe(404);
    link = reset;
    const acc = await guest.c.post(`/api/invites/${tokenOf(link.url)}/accept`);
    expect(acc.json.workspace.role).toBe('viewer');
    // a viewer cannot invite, nor see the link
    expect(
      (await guest.c.post(`/api/workspaces/${ws}/invites`, { emails: ['x@example.com'], role: 'viewer' }))
        .status,
    ).toBe(403);
    expect((await guest.c.get(`/api/workspaces/${ws}/invites`)).json.link).toBeNull();
    await own.c.patch(`/api/workspaces/${ws}/link`, { enabled: false });
    expect((await guest.c.get(`/api/invites/${tokenOf(link.url)}`)).status).toBe(404);
  });

  it('team roles give a baseline on team content', async () => {
    const own = await signup(app, 'rlown');
    const ed = await signup(app, 'rled');
    const vw = await signup(app, 'rlvw');
    const ws = (await team(own.c, 'Roles')).id;
    await join(own.c, ws, ed, 'editor');
    await join(own.c, ws, vw, 'viewer');

    const doc = (await ed.c.post('/api/documents', { workspaceId: ws, title: 'Roadmap' })).json
      .document;
    expect(doc.role).toBe('owner');
    expect((await own.c.get(`/api/documents/${doc.id}`)).json.document.role).toBe('owner');
    expect((await vw.c.get(`/api/documents/${doc.id}`)).json.document.role).toBe('commenter');
    expect((await vw.c.post('/api/documents', { workspaceId: ws, title: 'x' })).status).toBe(403);
    expect((await vw.c.get(`/api/workspaces/${ws}/tree`)).json.documents).toHaveLength(1);

    // "Everyone: view only" on a folder narrows editors there.
    const f = (await own.c.post('/api/folders', { workspaceId: ws, name: 'Minutes' })).json.folder;
    const d2 = (await own.c.post('/api/documents', { workspaceId: ws, folderId: f.id, title: 'M' }))
      .json.document;
    expect((await ed.c.get(`/api/documents/${d2.id}`)).json.document.role).toBe('editor');
    await own.c.post(`/api/folders/${f.id}/grants`, { workspace: true, role: 'viewer' });
    expect((await ed.c.get(`/api/documents/${d2.id}`)).json.document.role).toBe('viewer');

    // Only owners change roles; the last owner cannot step down or leave.
    const me = (await own.c.get('/api/auth/me')).json.user;
    expect(
      (await ed.c.patch(`/api/workspaces/${ws}/members/${me.id}`, { role: 'viewer' })).status,
    ).toBe(403);
    expect(
      (await own.c.patch(`/api/workspaces/${ws}/members/${me.id}`, { role: 'editor' })).status,
    ).toBe(400);
    expect((await own.c.del(`/api/workspaces/${ws}/members/${me.id}`)).status).toBe(400);
    await own.c.patch(`/api/workspaces/${ws}/members/${vw.user.id}`, { role: 'editor' });
    expect((await vw.c.get(`/api/documents/${d2.id}`)).json.document.role).toBe('viewer');
    expect((await vw.c.get(`/api/documents/${doc.id}`)).json.document.role).toBe('editor');
  });

  it('restricted folders are hidden everywhere from members not added', async () => {
    const own = await signup(app, 'rsown');
    const ed = await signup(app, 'rsed');
    const pal = await signup(app, 'rspal');
    const ws = (await team(own.c, 'Secret')).id;
    await join(own.c, ws, ed, 'editor');
    await join(own.c, ws, pal, 'editor');

    // Ed makes a folder and restricts it, adding Pal.
    const f = (await ed.c.post('/api/folders', { workspaceId: ws, name: 'Funding' })).json.folder;
    const doc = (
      await ed.c.post('/api/documents', {
        workspaceId: ws,
        folderId: f.id,
        markdown: '# Term sheet\n\nvaluation zebra',
      })
    ).json.document;
    await own.c.put(`/api/documents/${doc.id}/star`);
    await own.c.post(`/api/documents/${doc.id}/threads`, { anchor: null, body: 'hi @rsed' });
    // the team owner cannot restrict someone else's folder
    expect((await own.c.patch(`/api/folders/${f.id}`, { restricted: true })).status).toBe(403);
    expect((await ed.c.patch(`/api/folders/${f.id}`, { restricted: true })).json.folder.restricted).toBe(
      true,
    );
    await ed.c.post(`/api/folders/${f.id}/grants`, { email: 'rspal@example.com', role: 'viewer' });

    // The team owner sees nothing of it.
    expect((await own.c.get(`/api/documents/${doc.id}`)).status).toBe(404);
    expect((await own.c.get(`/api/folders/${f.id}`)).status).toBe(404);
    const tree = (await own.c.get(`/api/workspaces/${ws}/tree`)).json;
    expect(tree.folders).toHaveLength(0);
    expect(tree.documents).toHaveLength(0);
    expect((await own.c.get(`/api/workspaces/${ws}/search?q=zebra`)).json.results).toHaveLength(0);
    expect((await own.c.get(`/api/workspaces/${ws}/recent`)).json.documents).toHaveLength(0);
    expect((await own.c.get(`/api/workspaces/${ws}/starred`)).json.documents).toHaveLength(0);
    expect((await own.c.get(`/api/documents/${doc.id}/markdown`)).status).toBe(404);
    // Ed's mention list no longer offers the owner, and Ed's inbox keeps the old mention
    // because Ed can still read it.
    const m = (await ed.c.get(`/api/documents/${doc.id}/mentionable`)).json.users;
    expect(m.map((u: { name: string }) => u.name).sort()).toEqual(['rsed', 'rspal']);

    // A notification about it disappears for someone who lost access.
    await ed.c.post(`/api/documents/${doc.id}/threads`, { anchor: null, body: 'ping @rspal' });
    expect(
      (await pal.c.get('/api/notifications')).json.notifications.some(
        (n: { document: { id: string } | null }) => n.document?.id === doc.id,
      ),
    ).toBe(true);
    await ed.c.del(
      `/api/grants/${(await ed.c.get(`/api/folders/${f.id}/sharing`)).json.grants[0].id}`,
    );
    expect(
      (await pal.c.get('/api/notifications')).json.notifications.some(
        (n: { document: { id: string } | null }) => n.document?.id === doc.id,
      ),
    ).toBe(false);
    expect((await pal.c.get(`/api/documents/${doc.id}`)).status).toBe(404);

    // Lifting the restriction gives the team its access back.
    await ed.c.patch(`/api/folders/${f.id}`, { restricted: false });
    expect((await own.c.get(`/api/documents/${doc.id}`)).json.document.role).toBe('owner');
  });

  it('removing a member hands their content to an owner and drops their access', async () => {
    const own = await signup(app, 'rmown');
    const ed = await signup(app, 'rmed');
    const ws = (await team(own.c, 'Leavers')).id;
    await join(own.c, ws, ed, 'editor');
    const f = (await ed.c.post('/api/folders', { workspaceId: ws, name: 'Mine' })).json.folder;
    await ed.c.patch(`/api/folders/${f.id}`, { restricted: true });
    const doc = (await ed.c.post('/api/documents', { workspaceId: ws, folderId: f.id, title: 'D' }))
      .json.document;
    expect((await own.c.get(`/api/documents/${doc.id}`)).status).toBe(404);

    expect((await own.c.del(`/api/workspaces/${ws}/members/${ed.user.id}`)).status).toBe(200);
    expect((await ed.c.get(`/api/documents/${doc.id}`)).status).toBe(404);
    expect((await ed.c.get(`/api/workspaces/${ws}/tree`)).status).toBe(404);
    // The restricted folder is now the owner's.
    expect((await own.c.get(`/api/documents/${doc.id}`)).json.document.role).toBe('owner');
  });

  it('moves a personal document into a team, keeping its share link', async () => {
    const own = await signup(app, 'mvown');
    const ed = await signup(app, 'mved');
    const ws = (await team(own.c, 'Movers')).id;
    await join(own.c, ws, ed, 'viewer');
    const doc = (await own.c.post('/api/documents', { workspaceId: own.workspace.id, title: 'Notes' }))
      .json.document;
    const link = (await own.c.post(`/api/documents/${doc.id}/links`, { role: 'viewer' })).json.link;
    expect((await ed.c.get(`/api/documents/${doc.id}`)).status).toBe(404);
    // a viewer cannot move things in
    expect(
      (await ed.c.post(`/api/documents/${doc.id}/move`, { workspaceId: ws })).status,
    ).toBe(404);
    expect((await own.c.post(`/api/documents/${doc.id}/move`, { workspaceId: ws })).status).toBe(200);
    const moved = (await ed.c.get(`/api/documents/${doc.id}`)).json.document;
    expect(moved).toMatchObject({ workspaceId: ws, role: 'commenter' });
    expect((await own.c.get(`/api/share/${link.token}`)).status).toBe(200);
    expect((await own.c.get(`/api/workspaces/${own.workspace.id}/tree`)).json.documents).toHaveLength(0);
  });

  it('deletes a team after typing its name', async () => {
    const own = await signup(app, 'dlown');
    const ws = (await team(own.c, 'Gone')).id;
    expect((await own.c.del(`/api/workspaces/${ws}?confirm=nope`)).status).toBe(400);
    expect((await own.c.del(`/api/workspaces/${own.workspace.id}?confirm=x`)).status).toBe(400);
    expect((await own.c.del(`/api/workspaces/${ws}?confirm=Gone`)).status).toBe(200);
    expect((await own.c.get('/api/auth/me')).json.workspaces).toHaveLength(1);
  });
});
