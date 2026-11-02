import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { markdownToYUpdate } from '@bee/editor/markdown';
import { client, setup, signup, type App } from './helpers.js';

let app: App;
let pool: { end: () => Promise<void> };
const SECRET = { 'x-collab-secret': 'test-secret' };

beforeAll(async () => {
  const s = await setup();
  app = s.app;
  pool = s.pool;
});
afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('auth', () => {
  it('registers, logs in, rejects duplicates and bad passwords', async () => {
    const { c, user, workspace } = await signup(app, 'auth1');
    expect(user.email).toBe('auth1@example.com');
    expect(workspace.role).toBe('owner');
    expect((await c.get('/api/auth/me')).json.user.id).toBe(user.id);

    const dup = await client(app).post('/api/auth/register', {
      email: 'AUTH1@example.com',
      password: 'password123',
      name: 'x',
    });
    expect(dup.status).toBe(409);

    const bad = await client(app).post('/api/auth/login', {
      email: 'auth1@example.com',
      password: 'nope',
    });
    expect(bad.status).toBe(400);
    const ok = client(app);
    expect(
      (await ok.post('/api/auth/login', { email: 'Auth1@example.com', password: 'password123' }))
        .status,
    ).toBe(200);
    expect((await ok.get('/api/auth/me')).status).toBe(200);
    await ok.post('/api/auth/logout');
    expect((await ok.get('/api/auth/me')).status).toBe(401);
  });

  it('validates input', async () => {
    const r = await client(app).post('/api/auth/register', {
      email: 'bad',
      password: 'short',
      name: '',
    });
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('validation');
  });

  it('stores reading prefs and merges partial updates', async () => {
    const { c, user } = await signup(app, 'prefs1');
    expect(user.prefs).toEqual({});
    await c.patch('/api/auth/me', { prefs: { docFontSize: 'small' } });
    const r = await c.patch('/api/auth/me', { prefs: { docFont: 'serif' } });
    expect(r.json.user.prefs).toEqual({ docFontSize: 'small', docFont: 'serif' });
    expect((await c.get('/api/auth/me')).json.user.prefs).toEqual({ docFontSize: 'small', docFont: 'serif' });
    expect((await c.patch('/api/auth/me', { prefs: { docFont: 'comic' } })).status).toBe(400);
  });
});

describe('documents, folders and permissions', () => {
  it('private by default, folder grants inherit, doc grants override', async () => {
    const alice = await signup(app, 'alice');
    const bob = await signup(app, 'bob');
    const ws = alice.workspace.id;

    // Bob joins Alice's workspace.
    expect(
      (
        await alice.c.post(`/api/workspaces/${ws}/members`, {
          email: 'bob@example.com',
          role: 'member',
        })
      ).status,
    ).toBe(201);

    const folder = (await alice.c.post('/api/folders', { workspaceId: ws, name: 'Specs' })).json
      .folder;
    const sub = (
      await alice.c.post('/api/folders', { workspaceId: ws, parentId: folder.id, name: 'Sub' })
    ).json.folder;
    const doc = (
      await alice.c.post('/api/documents', { workspaceId: ws, folderId: sub.id, title: 'Plan' })
    ).json.document;
    expect(doc.role).toBe('owner');

    // Private: Bob sees nothing and gets 404.
    expect((await bob.c.get(`/api/workspaces/${ws}/tree`)).json.documents).toHaveLength(0);
    expect((await bob.c.get(`/api/documents/${doc.id}`)).status).toBe(404);

    // Share the top folder with Bob as commenter: inherited by the doc.
    const g = await alice.c.post(`/api/folders/${folder.id}/grants`, {
      email: 'bob@example.com',
      role: 'commenter',
    });
    expect(g.status).toBe(201);
    expect((await bob.c.get(`/api/documents/${doc.id}`)).json.document.role).toBe('commenter');
    const tree = (await bob.c.get(`/api/workspaces/${ws}/tree`)).json;
    expect(tree.folders.map((f: any) => f.name).sort()).toEqual(['Specs', 'Sub']);
    expect(tree.documents.map((d: any) => d.id)).toEqual([doc.id]);

    // Commenter cannot edit metadata.
    expect((await bob.c.patch(`/api/documents/${doc.id}`, { title: 'x' })).status).toBe(403);

    // Doc-level grant overrides the folder grant (narrower or wider).
    await alice.c.post(`/api/documents/${doc.id}/grants`, {
      email: 'bob@example.com',
      role: 'editor',
    });
    expect((await bob.c.get(`/api/documents/${doc.id}`)).json.document.role).toBe('editor');
    expect(
      (await bob.c.patch(`/api/documents/${doc.id}`, { title: 'Plan v2' })).json.document.title,
    ).toBe('Plan v2');

    const sharing = (await alice.c.get(`/api/documents/${doc.id}/sharing`)).json;
    expect(sharing.grants).toHaveLength(1); // folder grant for bob is overridden
    expect(sharing.grants[0].role).toBe('editor');

    // Editors cannot move or delete.
    expect((await bob.c.patch(`/api/documents/${doc.id}`, { folderId: null })).status).toBe(403);
    expect((await bob.c.del(`/api/documents/${doc.id}`)).status).toBe(403);

    // Workspace-wide grant.
    const doc2 = (await alice.c.post('/api/documents', { workspaceId: ws, title: 'Team' })).json
      .document;
    expect((await bob.c.get(`/api/documents/${doc2.id}`)).status).toBe(404);
    await alice.c.post(`/api/documents/${doc2.id}/grants`, { workspace: true, role: 'viewer' });
    expect((await bob.c.get(`/api/documents/${doc2.id}`)).json.document.role).toBe('viewer');

    // Cannot move a folder into its own descendant.
    expect((await alice.c.patch(`/api/folders/${folder.id}`, { parentId: sub.id })).status).toBe(
      400,
    );

    // Trash: deleting the folder hides its contents; restore brings them back.
    await alice.c.del(`/api/folders/${folder.id}`);
    expect(
      (await alice.c.get(`/api/workspaces/${ws}/tree`)).json.documents.map((d: any) => d.id),
    ).toEqual([doc2.id]);
    expect(
      (await alice.c.get(`/api/workspaces/${ws}/trash`)).json.folders.map((f: any) => f.id),
    ).toEqual([folder.id]);
    await alice.c.post(`/api/folders/${folder.id}/restore`);
    expect((await alice.c.get(`/api/workspaces/${ws}/tree`)).json.documents).toHaveLength(2);

    // Doc trash + permanent delete.
    await alice.c.del(`/api/documents/${doc2.id}`);
    expect((await bob.c.get(`/api/documents/${doc2.id}`)).status).toBe(404);
    expect(
      (await alice.c.get(`/api/workspaces/${ws}/trash`)).json.documents.map((d: any) => d.id),
    ).toEqual([doc2.id]);
    expect((await alice.c.del(`/api/documents/${doc2.id}?permanent=1`)).status).toBe(200);
    expect((await alice.c.get(`/api/documents/${doc2.id}`)).status).toBe(404);
  });

  it('imports and exports markdown, searches, resolves block links', async () => {
    const { c, workspace } = await signup(app, 'md');
    const md = '# Hello world\n\nSome **bold** text about bees.\n\n- one\n- two\n';
    const doc = (await c.post('/api/documents', { workspaceId: workspace.id, markdown: md })).json
      .document;
    expect(doc.title).toBe('Hello world');
    const exp = await c.get(`/api/documents/${doc.id}/export.md`);
    expect(exp.res.body).toContain('**bold**');
    const s = (await c.get(`/api/workspaces/${workspace.id}/search?q=bees`)).json.results;
    expect(s).toHaveLength(1);
    expect(s[0].snippet).toContain('bees');
    expect((await c.get(`/api/documents/${doc.id}/blocks/nope`)).json.exists).toBe(false);
    const recent = (await c.get(`/api/workspaces/${workspace.id}/recent`)).json.documents;
    expect(recent[0].id).toBe(doc.id);
  });
});

describe('share links', () => {
  it('public links allow anonymous view, private links need sign-in', async () => {
    const owner = await signup(app, 'linkowner');
    const doc = (
      await owner.c.post('/api/documents', { workspaceId: owner.workspace.id, title: 'Public' })
    ).json.document;
    const link = (
      await owner.c.post(`/api/documents/${doc.id}/links`, { role: 'commenter', public: true })
    ).json.link;
    expect(link.url).toContain(`/s/${link.token}`);

    const anon = client(app);
    const r = await anon.get(`/api/share/${link.token}`);
    expect(r.status).toBe(200);
    expect(r.json.role).toBe('viewer'); // anonymous capped at viewer
    expect(
      (await anon.get(`/api/documents/${doc.id}`, { 'x-share-token': link.token })).status,
    ).toBe(200);
    expect((await anon.get(`/api/documents/${doc.id}`)).status).toBe(401);

    // A signed-in stranger gets the link role and can comment.
    const carol = await signup(app, 'carol');
    expect((await carol.c.get(`/api/share/${link.token}`)).json.role).toBe('commenter');
    const t = await carol.c.post(
      `/api/documents/${doc.id}/threads`,
      { anchor: null, body: 'Nice' },
      { 'x-share-token': link.token },
    );
    expect(t.status).toBe(201);

    const priv = (
      await owner.c.post(`/api/documents/${doc.id}/links`, { role: 'viewer', public: false })
    ).json.link;
    expect((await anon.get(`/api/share/${priv.token}`)).status).toBe(400);
    expect((await carol.c.get(`/api/share/${priv.token}`)).status).toBe(200);

    // Revoke.
    await owner.c.del(`/api/links/${link.id}`);
    expect((await anon.get(`/api/share/${link.token}`)).status).toBe(404);
  });
});

describe('guest comments', () => {
  it('guest comments need a public commenter link', async () => {
    const owner = await signup(app, 'guestowner2');
    const doc = (
      await owner.c.post('/api/documents', { workspaceId: owner.workspace.id, title: 'Closed' })
    ).json.document;
    const link = (
      await owner.c.post(`/api/documents/${doc.id}/links`, {
        role: 'viewer',
        public: true,
        guestComments: true,
      })
    ).json.link;
    const anon = client(app);
    const res = await anon.post(
      `/api/documents/${doc.id}/threads`,
      { anchor: null, body: 'Hi', guestName: 'Ann' },
      { 'x-share-token': link.token, 'x-guest-key': 'guest-key-three-0123456789' },
    );
    expect(res.status).toBe(401);
  });

  it('public links with guest comments let anonymous visitors comment under a nickname', async () => {
    const owner = await signup(app, 'guestowner');
    const doc = (
      await owner.c.post('/api/documents', { workspaceId: owner.workspace.id, title: 'Open' })
    ).json.document;
    const link = (
      await owner.c.post(`/api/documents/${doc.id}/links`, {
        role: 'commenter',
        public: true,
        guestComments: true,
      })
    ).json.link;
    expect(link.guestComments).toBe(true);

    const anon = client(app);
    const share = { 'x-share-token': link.token };
    const g1 = { ...share, 'x-guest-key': 'guest-key-one-0123456789' };
    const g2 = { ...share, 'x-guest-key': 'guest-key-two-0123456789' };
    expect((await anon.get(`/api/share/${link.token}`)).json.role).toBe('commenter');

    // A nickname is required.
    const noName = await anon.post(
      `/api/documents/${doc.id}/threads`,
      { anchor: null, body: 'Hi' },
      g1,
    );
    expect(noName.status).toBe(400);
    expect(noName.json.error.code).toBe('guest_name_required');

    const t = await anon.post(
      `/api/documents/${doc.id}/threads`,
      { anchor: null, body: 'Hello from a guest', guestName: 'Ann' },
      g1,
    );
    expect(t.status).toBe(201);
    const first = t.json.thread.comments[0];
    expect(first).toMatchObject({ guest: true, canDelete: true, author: { id: '', name: 'Ann' } });
    const r = await anon.post(
      `/api/threads/${t.json.thread.id}/comments`,
      { body: 'Reply', guestName: 'Ben' },
      g2,
    );
    expect(r.status).toBe(201);

    // Each guest may delete only their own comments; the owner may delete any.
    const seen = (await anon.get(`/api/documents/${doc.id}/threads`, g2)).json.threads[0].comments;
    expect(seen.map((c: { canDelete: boolean }) => c.canDelete)).toEqual([false, true]);
    expect((await anon.del(`/api/comments/${first.id}`, g2)).status).toBe(403);
    const ownerView = (await owner.c.get(`/api/documents/${doc.id}/threads`)).json.threads[0];
    expect(ownerView.comments.every((c: { canDelete: boolean }) => c.canDelete)).toBe(true);
    expect((await owner.c.del(`/api/comments/${first.id}`)).status).toBe(200);
    expect((await anon.del(`/api/comments/${r.json.comment.id}`, g2)).status).toBe(200);
    expect((await owner.c.get(`/api/documents/${doc.id}/threads`)).json.threads).toHaveLength(0);

    // Guests cannot resolve threads or edit the document's sharing.
    expect(
      (await anon.patch(`/api/threads/${t.json.thread.id}`, { resolved: true }, g1)).status,
    ).toBe(401);

    // Rate limit per IP.
    let limited = false;
    for (let i = 0; i < 10 && !limited; i++) {
      const x = await anon.post(
        `/api/documents/${doc.id}/threads`,
        { anchor: null, body: `spam ${i}`, guestName: 'Spam' },
        g1,
      );
      limited = x.status === 429;
    }
    expect(limited).toBe(true);

    // Turning guest comments off stops anonymous comments.
    await owner.c.patch(`/api/links/${link.id}`, { guestComments: false });
    expect((await anon.get(`/api/share/${link.token}`)).json.role).toBe('viewer');
  });
});

describe('embedded documents', () => {
  it('a whiteboard inside a doc inherits the parent access and share link', async () => {
    const owner = await signup(app, 'embedowner');
    const other = await signup(app, 'embedother');
    const doc = (
      await owner.c.post('/api/documents', { workspaceId: owner.workspace.id, title: 'Host' })
    ).json.document;
    const wb = (
      await owner.c.post('/api/documents', { parentDocumentId: doc.id, type: 'whiteboard' })
    ).json.document;
    expect(wb.parentDocumentId).toBe(doc.id);
    expect(
      (await owner.c.get(`/api/workspaces/${owner.workspace.id}/tree`)).json.documents,
    ).toHaveLength(1);

    expect((await other.c.get(`/api/documents/${wb.id}`)).status).toBe(404);
    expect(
      (await other.c.post('/api/documents', { parentDocumentId: doc.id, type: 'whiteboard' }))
        .status,
    ).toBe(404);
    await owner.c.post(`/api/documents/${doc.id}/grants`, {
      email: 'embedother@example.com',
      role: 'viewer',
    });
    expect((await other.c.get(`/api/documents/${wb.id}`)).json.document.role).toBe('viewer');

    const link = (
      await owner.c.post(`/api/documents/${doc.id}/links`, { role: 'viewer', public: true })
    ).json.link;
    const r = await app.inject({
      method: 'POST',
      url: '/api/internal/collab/auth',
      payload: { documentId: wb.id, shareToken: link.token },
      headers: SECRET,
    });
    expect(r.json()).toMatchObject({ role: 'viewer', readOnly: true, documentType: 'whiteboard' });
  });
});

describe('comments', () => {
  it('threads, replies, resolve, permissions', async () => {
    const owner = await signup(app, 'cowner');
    const viewer = await signup(app, 'cviewer');
    const ws = owner.workspace.id;
    await owner.c.post(`/api/workspaces/${ws}/members`, {
      email: 'cviewer@example.com',
      role: 'member',
    });
    const doc = (await owner.c.post('/api/documents', { workspaceId: ws, title: 'C' })).json
      .document;
    await owner.c.post(`/api/documents/${doc.id}/grants`, {
      email: 'cviewer@example.com',
      role: 'viewer',
    });

    const anchor = {
      blockId: 'b1',
      from: { type: null, tname: 'default', item: { client: 1, clock: 0 }, assoc: 0 },
      to: null,
      quote: 'hello',
    };
    const t = (await owner.c.post(`/api/documents/${doc.id}/threads`, { anchor, body: 'First' }))
      .json.thread;
    expect(t.anchor.quote).toBe('hello');
    expect(t.comments[0].anchor.blockId).toBe('b1');
    expect(
      (await viewer.c.post(`/api/documents/${doc.id}/threads`, { anchor: null, body: 'x' })).status,
    ).toBe(403);
    expect((await viewer.c.get(`/api/documents/${doc.id}/threads`)).json.threads).toHaveLength(1);

    expect((await owner.c.post(`/api/threads/${t.id}/comments`, { body: 'Reply' })).status).toBe(
      201,
    );
    const resolved = (await owner.c.patch(`/api/threads/${t.id}`, { resolved: true })).json.thread;
    expect(resolved.resolved).toBe(true);
    expect(resolved.comments).toHaveLength(2);
    expect(
      (await owner.c.get(`/api/documents/${doc.id}/threads?resolved=0`)).json.threads,
    ).toHaveLength(0);
    const activity = (await owner.c.get(`/api/documents/${doc.id}/activity`)).json.items.map(
      (i: any) => i.kind,
    );
    expect(activity).toContain('resolved');
  });
});

describe('collab internal API and versions', () => {
  it('auth-checks connections, stores state, snapshots versions', async () => {
    const owner = await signup(app, 'collab');
    const doc = (
      await owner.c.post('/api/documents', { workspaceId: owner.workspace.id, title: 'Live' })
    ).json.document;

    const auth = (body: object) =>
      app.inject({
        method: 'POST',
        url: '/api/internal/collab/auth',
        payload: body,
        headers: SECRET,
      });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/internal/collab/auth',
          payload: { documentId: doc.id },
        })
      ).statusCode,
    ).toBe(401);
    const ok = await auth({ documentId: doc.id, cookie: `foo=bar; ${owner.c.cookie}` });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ role: 'owner', readOnly: false, documentType: 'doc' });
    expect((await auth({ documentId: doc.id })).statusCode).toBe(401);
    expect(
      (await auth({ documentId: '00000000-0000-4000-8000-000000000000', cookie: owner.c.cookie }))
        .statusCode,
    ).toBe(404);

    const link = (
      await owner.c.post(`/api/documents/${doc.id}/links`, { role: 'viewer', public: true })
    ).json.link;
    expect((await auth({ documentId: doc.id, shareToken: link.token })).json()).toMatchObject({
      user: null,
      role: 'viewer',
      readOnly: true,
    });

    const empty = await app.inject({
      method: 'GET',
      url: `/api/internal/collab/documents/${doc.id}/state`,
      headers: SECRET,
    });
    expect(empty.statusCode).toBe(204);

    const update = Buffer.from(markdownToYUpdate('# Title\n\nCollaborative bees'));
    const put = await app.inject({
      method: 'PUT',
      url: `/api/internal/collab/documents/${doc.id}/state`,
      payload: update,
      headers: {
        ...SECRET,
        'content-type': 'application/octet-stream',
        'x-author-ids': owner.user.id,
      },
    });
    expect(put.statusCode).toBe(204);
    const got = await app.inject({
      method: 'GET',
      url: `/api/internal/collab/documents/${doc.id}/state`,
      headers: SECRET,
    });
    expect(Buffer.compare(got.rawPayload, update)).toBe(0);
    expect(
      (await owner.c.get(`/api/workspaces/${owner.workspace.id}/search?q=collaborative`)).json
        .results,
    ).toHaveLength(1);

    const ver = (headers = {}) =>
      app.inject({
        method: 'POST',
        url: `/api/internal/collab/documents/${doc.id}/versions`,
        payload: update,
        headers: {
          ...SECRET,
          'content-type': 'application/octet-stream',
          'x-author-ids': owner.user.id,
          ...headers,
        },
      });
    expect((await ver()).statusCode).toBe(201);
    expect((await ver()).statusCode).toBe(200); // identical snapshot is skipped

    const manual = await owner.c.post(`/api/documents/${doc.id}/versions`, { label: 'v1' });
    expect(manual.status).toBe(201);
    const list = (await owner.c.get(`/api/documents/${doc.id}/versions`)).json.versions;
    expect(list).toHaveLength(2);
    expect(list[0].label).toBe('v1');
    expect(list[1].authors[0].name).toBe('collab');
    const content = (await owner.c.get(`/api/documents/${doc.id}/versions/${list[1].id}`)).json;
    expect(content.text).toContain('Collaborative bees');
    expect(content.content.type).toBe('doc');

    const cur = (await owner.c.get(`/api/documents/${doc.id}/versions/current`)).json;
    expect(cur.text).toContain('Collaborative bees');

    // Restore needs the collab server; here it is unreachable, so 503.
    expect(
      (await owner.c.post(`/api/documents/${doc.id}/versions/${list[1].id}/restore`)).status,
    ).toBe(503);
  });
});
