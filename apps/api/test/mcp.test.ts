import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { client, setup, signup, type App } from './helpers.js';

let app: App;
let pool: { end: () => Promise<void> };
let fakeCollab: Server;
const collabCalls: { method: string; url: string; body: string }[] = [];

beforeAll(async () => {
  // Stand-in for the collab server's internal Markdown endpoints.
  fakeCollab = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      collabCalls.push({ method: req.method!, url: req.url!, body });
      res.setHeader('content-type', 'application/json');
      if (req.url!.endsWith('/anchor')) {
        const { quote } = JSON.parse(body) as { quote: string };
        if (quote === 'absent') {
          res.statusCode = 409;
          return res.end(JSON.stringify({ error: { code: 'not_found', message: 'not there' } }));
        }
        return res.end(JSON.stringify({ anchor: { blockId: 'b1', from: {}, to: {}, quote } }));
      }
      if (req.method === 'GET')
        return res.end(JSON.stringify({ markdown: '# Live\n', live: true }));
      const edit = JSON.parse(body) as { mode: string; find?: string };
      if (edit.find === 'missing') {
        res.statusCode = 409;
        return res.end(JSON.stringify({ error: { code: 'not_found', message: 'nope' } }));
      }
      res.end(JSON.stringify({ markdown: 'x', kept: 1, removed: 0, inserted: 1 }));
    });
  });
  await new Promise<void>((r) => fakeCollab.listen(0, '127.0.0.1', r));
  const port = (fakeCollab.address() as AddressInfo).port;
  process.env.NODE_ENV = 'test';
  const s = await setup();
  pool = s.pool;
  // Rebuild with collab pointed at the fake.
  await s.app.close();
  const { buildApp } = await import('../src/app.js');
  app = await buildApp({
    db: s.db,
    config: { ...s.config, collabInternalUrl: `http://127.0.0.1:${port}` },
  });
});
afterAll(async () => {
  await app.close();
  await pool.end();
  fakeCollab.close();
});

const b64url = (b: Buffer) => b.toString('base64url');

async function oauthToken(c: ReturnType<typeof client>) {
  const reg = await app.inject({
    method: 'POST',
    url: '/oauth/register',
    payload: { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] },
  });
  expect(reg.statusCode).toBe(201);
  const clientId = reg.json().client_id as string;
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    resource: 'http://localhost:7070/mcp',
  });
  // Signed out: sent to the web login, which returns here.
  const anon = await app.inject({ method: 'GET', url: `/oauth/authorize?${q}` });
  expect(anon.statusCode).toBe(302);
  expect(anon.headers.location).toBe(`/login?next=${encodeURIComponent(`/oauth/authorize?${q}`)}`);

  const consent = await c.get(`/oauth/authorize?${q}`);
  expect(consent.status).toBe(200);
  expect(consent.res.body).toContain('Claude');
  const csrf = /name="csrf" value="([^"]+)"/.exec(consent.res.body)![1]!;

  const form = new URLSearchParams({ ...Object.fromEntries(q), csrf, action: 'allow' });
  const bad = await app.inject({
    method: 'POST',
    url: '/oauth/authorize',
    headers: { cookie: c.cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({
      ...Object.fromEntries(q),
      csrf: 'forged',
      action: 'allow',
    }).toString(),
  });
  expect(bad.statusCode).toBe(403);
  const allow = await app.inject({
    method: 'POST',
    url: '/oauth/authorize',
    headers: { cookie: c.cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: form.toString(),
  });
  expect(allow.statusCode).toBe(302);
  const back = new URL(allow.headers.location as string);
  expect(back.origin + back.pathname).toBe('https://claude.ai/api/mcp/auth_callback');
  expect(back.searchParams.get('state')).toBe('xyz');
  const code = back.searchParams.get('code')!;

  const tokenReq = (extra: Record<string, string>) =>
    app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ client_id: clientId, ...extra }).toString(),
    });
  const wrong = await tokenReq({
    grant_type: 'authorization_code',
    code,
    code_verifier: 'x'.repeat(43),
  });
  expect(wrong.statusCode).toBe(400);
  // The failed attempt consumed the code.
  expect(
    (await tokenReq({ grant_type: 'authorization_code', code, code_verifier: verifier }))
      .statusCode,
  ).toBe(400);
  return { clientId, verifier, challenge, q, tokenReq, c };
}

const rpc = (token: string | null, body: unknown) =>
  app.inject({
    method: 'POST',
    url: '/mcp',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    payload: JSON.stringify(body),
  });

const callTool = async (token: string, name: string, args: Record<string, unknown> = {}) => {
  const r = await rpc(token, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  });
  expect(r.statusCode).toBe(200);
  const res = r.json().result as { content: { text: string }[]; isError?: boolean };
  return { text: res.content[0]!.text, isError: !!res.isError };
};

describe('oauth', () => {
  it('serves discovery metadata', async () => {
    const as = await app.inject({ method: 'GET', url: '/.well-known/oauth-authorization-server' });
    expect(as.json()).toMatchObject({
      issuer: 'http://localhost:7070',
      token_endpoint: 'http://localhost:7070/oauth/token',
      code_challenge_methods_supported: ['S256'],
    });
    const pr = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource/mcp',
    });
    expect(pr.json()).toMatchObject({ resource: 'http://localhost:7070/mcp' });
  });

  it('rejects bad registrations', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      payload: { redirect_uris: ['http://evil.example.com/cb'] },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe('invalid_redirect_uri');
  });

  it('runs the code flow with PKCE, refreshes and revokes', async () => {
    const { c } = await signup(app, 'oauth1');
    const { verifier, challenge, q, tokenReq } = await oauthToken(c);
    // A fresh code for the happy path.
    const consent = await c.get(`/oauth/authorize?${q}`);
    const csrf = /name="csrf" value="([^"]+)"/.exec(consent.res.body)![1]!;
    expect(challenge).toBe(q.get('code_challenge'));
    const allow = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { cookie: c.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ ...Object.fromEntries(q), csrf, action: 'allow' }).toString(),
    });
    const code = new URL(allow.headers.location as string).searchParams.get('code')!;
    const tok = await tokenReq({ grant_type: 'authorization_code', code, code_verifier: verifier });
    expect(tok.statusCode).toBe(200);
    const { access_token, refresh_token, token_type } = tok.json();
    expect(token_type).toBe('Bearer');
    expect(
      (await c.get('/api/auth/me', { authorization: `Bearer ${access_token}` })).json.user.email,
    ).toBe('oauth1@example.com');

    const refreshed = await tokenReq({ grant_type: 'refresh_token', refresh_token });
    expect(refreshed.statusCode).toBe(200);
    // Rotation: the old refresh token is spent.
    expect((await tokenReq({ grant_type: 'refresh_token', refresh_token })).statusCode).toBe(400);

    const apps = await c.get('/api/connected-apps');
    expect(apps.json.apps).toHaveLength(1);
    expect(apps.json.apps[0].name).toBe('Claude');
    await c.del(`/api/connected-apps/${apps.json.apps[0].id}`);
    expect(
      (await c.get('/api/auth/me', { authorization: `Bearer ${refreshed.json().access_token}` }))
        .status,
    ).toBe(401);
  });

  it('deny redirects back with access_denied', async () => {
    const { c } = await signup(app, 'oauth2');
    const { q } = await oauthToken(c);
    const consent = await c.get(`/oauth/authorize?${q}`);
    const csrf = /name="csrf" value="([^"]+)"/.exec(consent.res.body)![1]!;
    const deny = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { cookie: c.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ ...Object.fromEntries(q), csrf, action: 'deny' }).toString(),
    });
    expect(new URL(deny.headers.location as string).searchParams.get('error')).toBe(
      'access_denied',
    );
  });
});

describe('personal tokens', () => {
  it('creates, uses and revokes tokens; tokens cannot manage tokens', async () => {
    const { c } = await signup(app, 'pat1');
    const created = await c.post('/api/tokens', { name: 'Claude Code' });
    expect(created.status).toBe(201);
    const secret = created.json.secret as string;
    expect(secret.startsWith('bee_pat_')).toBe(true);
    const auth = { authorization: `Bearer ${secret}` };
    expect((await client(app).get('/api/auth/me', auth)).status).toBe(200);
    expect((await client(app).get('/api/tokens', auth)).status).toBe(403);
    expect(
      (await client(app).get('/api/auth/me', { authorization: 'Bearer bee_pat_nope' })).status,
    ).toBe(401);
    const list = await c.get('/api/tokens');
    expect(list.json.tokens[0]).toMatchObject({ name: 'Claude Code', prefix: secret.slice(0, 12) });
    expect(list.json.tokens[0].lastUsedAt).not.toBeNull();
    await c.del(`/api/tokens/${list.json.tokens[0].id}`);
    expect((await client(app).get('/api/auth/me', auth)).status).toBe(401);
  });
});

describe('mcp', () => {
  it('asks for authentication with resource metadata', async () => {
    const r = await rpc(null, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(r.statusCode).toBe(401);
    expect(r.headers['www-authenticate']).toContain(
      'resource_metadata="http://localhost:7070/.well-known/oauth-protected-resource/mcp"',
    );
    expect(
      (await rpc('bee_oat_invalid', { jsonrpc: '2.0', id: 1, method: 'ping' })).statusCode,
    ).toBe(401);
  });

  it('initializes and lists tools', async () => {
    const { c } = await signup(app, 'mcp0');
    const secret = (await c.post('/api/tokens', { name: 't' })).json.secret;
    const init = await rpc(secret, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    });
    expect(init.json().result).toMatchObject({
      protocolVersion: '2025-06-18',
      serverInfo: { name: 'bee' },
    });
    expect(
      (await rpc(secret, { jsonrpc: '2.0', method: 'notifications/initialized' })).statusCode,
    ).toBe(202);
    const list = await rpc(secret, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const names = (
      list.json().result.tools as { name: string; inputSchema: { type: string } }[]
    ).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['list_documents', 'read_document', 'edit_document', 'add_comment']),
    );
    expect(list.json().result.tools[0].inputSchema.type).toBe('object');
    expect((await rpc(secret, { jsonrpc: '2.0', id: 3, method: 'nope' })).json().error.code).toBe(
      -32601,
    );
  });

  it('works with folders, documents and comments within permissions', async () => {
    const { c, workspace } = await signup(app, 'mcp1');
    const token = (await c.post('/api/tokens', { name: 't' })).json.secret as string;

    const folder = await callTool(token, 'create_folder', { name: 'Notes' });
    const folderId = /id: ([0-9a-f-]{36})/.exec(folder.text)![1]!;
    const created = await callTool(token, 'create_document', {
      folderId,
      markdown: '# Plan\n\nHello',
    });
    expect(created.text).toContain('Created "Plan"');
    const docId = /id: ([0-9a-f-]{36})/.exec(created.text)![1]!;

    // The leading heading became the title, not a duplicate first line.
    expect((await c.get(`/api/documents/${docId}/export.md`)).res.body).toBe('# Plan\n\nHello\n');

    const tree = await callTool(token, 'list_documents', {});
    expect(tree.text).toContain('[folder] Notes');
    expect(tree.text).toContain(`[doc] Plan (id: ${docId}`);
    expect((await callTool(token, 'list_workspaces')).text).toContain(workspace.id);
    expect((await callTool(token, 'search_documents', { query: 'Hello' })).text).toContain(docId);

    const read = await callTool(token, 'read_document', {
      documentId: docId,
      includeComments: true,
    });
    expect(read.text).toContain('# Live');
    expect(read.text).toContain('No comments.');

    const edit = await callTool(token, 'edit_document', {
      documentId: docId,
      mode: 'str_replace',
      find: 'Hello',
      replace: 'Hi',
    });
    expect(edit.isError).toBe(false);
    const sent = collabCalls.findLast((x) => x.method === 'POST' && x.url.endsWith('/markdown'))!;
    expect(sent.url).toBe(`/internal/documents/${docId}/markdown`);
    expect(JSON.parse(sent.body)).toMatchObject({
      mode: 'str_replace',
      find: 'Hello',
      replace: 'Hi',
    });
    expect(JSON.parse(sent.body).authorId).toBeTruthy();
    const missing = await callTool(token, 'edit_document', {
      documentId: docId,
      mode: 'str_replace',
      find: 'missing',
    });
    expect(missing).toEqual({ text: 'nope', isError: true });

    const comment = await callTool(token, 'add_comment', {
      documentId: docId,
      body: 'Looks good',
      quote: 'Hi',
    });
    expect(comment.text).toContain('on "Hi"');
    const threadId = /thread ([0-9a-f-]{36})/.exec(comment.text)![1]!;
    expect(
      (await callTool(token, 'add_comment', { documentId: docId, body: 'x', quote: 'absent' }))
        .isError,
    ).toBe(true);
    await callTool(token, 'reply_to_comment', { threadId, body: 'Thanks' });
    expect((await callTool(token, 'list_comments', { documentId: docId })).text).toContain(
      'Thanks',
    );
    await callTool(token, 'resolve_comment', { threadId });
    expect((await callTool(token, 'list_comments', { documentId: docId })).text).toBe(
      'No comments.',
    );

    await callTool(token, 'update_document', {
      documentId: docId,
      title: 'Plan v2',
      folderId: null,
    });
    expect((await callTool(token, 'list_documents', {})).text).toMatch(/^- \[doc\] Plan v2/m);

    // Another user cannot see or edit it.
    const other = await signup(app, 'mcp2');
    const otherToken = (await other.c.post('/api/tokens', { name: 't' })).json.secret as string;
    const denied = await callTool(otherToken, 'read_document', { documentId: docId });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('not found');
    const deniedEdit = await callTool(otherToken, 'edit_document', {
      documentId: docId,
      mode: 'append',
      markdown: 'x',
    });
    expect(deniedEdit.isError).toBe(true);
    expect(
      collabCalls.filter(
        (x) => x.url.includes(docId) && x.method === 'POST' && x.url.endsWith('/markdown'),
      ),
    ).toHaveLength(2);

    expect((await callTool(token, 'trash_document', { documentId: docId })).text).toBe(
      'Moved to the trash.',
    );
  });
});
