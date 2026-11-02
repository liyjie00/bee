import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as Y from 'yjs';
import { HocuspocusProvider } from '@hocuspocus/provider';
import type { Server } from '@hocuspocus/server';
import { markdownToYUpdate, yUpdateToMarkdown } from '@bee/editor/markdown';
import { createCollabServer } from '../src/server.js';

const SECRET = 'test-secret';

/** In-memory stand-in for apps/api's /api/internal/collab endpoints. */
class FakeApi {
  states = new Map<string, Uint8Array>();
  storeAuthors = new Map<string, string[]>();
  markdown = new Map<string, string>();
  versions: { documentId: string; snapshot: Uint8Array; authorIds: string[] }[] = [];
  /** token -> { userId, role } */
  tokens: Record<string, { userId: string | null; role: string }> = {
    'editor-a': { userId: 'user-a', role: 'editor' },
    'editor-b': { userId: 'user-b', role: 'owner' },
    viewer: { userId: 'user-v', role: 'viewer' },
    commenter: { userId: 'user-c', role: 'commenter' },
  };
  http!: HttpServer;
  url = '';

  async start() {
    this.http = createServer(async (req, res) => {
      if (req.headers['x-collab-secret'] !== SECRET) return res.writeHead(401).end();
      const body = await read(req);
      const url = req.url ?? '';
      let m: RegExpExecArray | null;
      if (url === '/api/internal/collab/auth' && req.method === 'POST') {
        const input = JSON.parse(body.toString()) as { documentId: string; shareToken?: string };
        if (input.documentId === 'missing') return res.writeHead(404).end();
        const auth = input.shareToken ? this.tokens[input.shareToken] : undefined;
        if (!auth) return res.writeHead(401).end();
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(auth));
      }
      if ((m = /^\/api\/internal\/collab\/documents\/([^/]+)\/(state|markdown|versions)$/.exec(url))) {
        const [, id, kind] = m as unknown as [string, string, string];
        if (kind === 'state' && req.method === 'GET') {
          const state = this.states.get(id);
          if (!state) return res.writeHead(204).end();
          res.writeHead(200, { 'content-type': 'application/octet-stream' });
          return res.end(Buffer.from(state));
        }
        if (kind === 'state' && req.method === 'PUT') {
          this.states.set(id, new Uint8Array(body));
          const header = String(req.headers['x-author-ids'] ?? '');
          if (header) this.storeAuthors.set(id, [...(this.storeAuthors.get(id) ?? []), ...header.split(',')]);
        }
        else if (kind === 'markdown') this.markdown.set(id, body.toString());
        else if (kind === 'versions') {
          const header = String(req.headers['x-author-ids'] ?? '');
          this.versions.push({ documentId: id, snapshot: new Uint8Array(body), authorIds: header ? header.split(',') : [] });
          return res.writeHead(201).end();
        }
        return res.writeHead(204).end();
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => this.http.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.http.address() as AddressInfo).port}`;
  }
}

function read(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, timeout = 4000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeout) throw new Error('timed out');
    await sleep(20);
  }
}

let api: FakeApi;
let server: Server;
let wsUrl: string;
let httpUrl: string;
const providers: HocuspocusProvider[] = [];

function connect(name: string, token: string) {
  const document = new Y.Doc();
  let failed: string | null = null;
  let synced = false;
  const provider = new HocuspocusProvider({
    url: wsUrl,
    name,
    token,
    document,
    onSynced: () => (synced = true),
    onAuthenticationFailed: ({ reason }) => (failed = reason),
  });
  providers.push(provider);
  return { provider, document, isSynced: () => synced, failure: () => failed };
}

beforeAll(async () => {
  api = new FakeApi();
  await api.start();
  server = createCollabServer({
    port: 0,
    apiUrl: api.url,
    collabSecret: SECRET,
    storeDebounceMs: 50,
    storeMaxDebounceMs: 200,
    snapshotIntervalMs: 60 * 60 * 1000,
  });
  await server.listen(0);
  const { port } = server.address;
  wsUrl = `ws://127.0.0.1:${port}/collab`;
  httpUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  for (const p of providers) p.destroy();
  await server.destroy();
  api.http.close();
});

describe('collab server', () => {
  it('answers health checks', async () => {
    const res = await fetch(`${httpUrl}/collab/health`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('loads stored state, syncs edits between editors and persists them', async () => {
    api.states.set('doc1', markdownToYUpdate('# Hello'));
    const a = connect('doc1', 'editor-a');
    const b = connect('doc1', 'editor-b');
    await waitFor(() => a.isSynced() && b.isSynced());
    expect(yUpdateToMarkdown(Y.encodeStateAsUpdate(a.document))).toBe('# Hello\n');

    const para = new Y.XmlElement('paragraph');
    para.insert(0, [new Y.XmlText('from a')]);
    a.document.getXmlFragment('default').push([para]);
    await waitFor(() => b.document.getXmlFragment('default').length === 2);

    await waitFor(() => (api.markdown.get('doc1') ?? '').includes('from a'));
    expect(yUpdateToMarkdown(api.states.get('doc1')!)).toBe('# Hello\n\nfrom a\n');
    expect(api.storeAuthors.get('doc1')).toEqual(['user-a']);
  });

  it('keeps viewers and commenters read-only', async () => {
    const editor = connect('doc2', 'editor-a');
    const viewer = connect('doc2', 'viewer');
    const commenter = connect('doc2', 'commenter');
    await waitFor(() => editor.isSynced() && viewer.isSynced() && commenter.isSynced());

    viewer.document.getXmlFragment('default').push([new Y.XmlElement('paragraph')]);
    commenter.document.getXmlFragment('default').push([new Y.XmlElement('paragraph')]);
    await sleep(300);
    expect(editor.document.getXmlFragment('default').length).toBe(0);
    expect(api.states.has('doc2')).toBe(false);
  });

  it('rejects connections the api refuses', async () => {
    const anon = connect('doc3', 'nobody');
    await waitFor(() => anon.failure() !== null);
    const missing = connect('missing', 'editor-a');
    await waitFor(() => missing.failure() !== null);
    expect(anon.isSynced()).toBe(false);
  });

  it('snapshots a version with its authors when the last editor leaves', async () => {
    const a = connect('doc4', 'editor-a');
    await waitFor(() => a.isSynced());
    const para = new Y.XmlElement('paragraph');
    para.insert(0, [new Y.XmlText('versioned')]);
    a.document.getXmlFragment('default').push([para]);
    await waitFor(() => api.states.has('doc4'));
    a.provider.destroy();
    await waitFor(() => api.versions.some((v) => v.documentId === 'doc4'));
    const version = api.versions.find((v) => v.documentId === 'doc4')!;
    expect(version.authorIds).toEqual(['user-a']);
    expect(yUpdateToMarkdown(version.snapshot)).toBe('versioned\n');
  });

  it('restores a snapshot into an open document', async () => {
    api.states.set('doc5', markdownToYUpdate('current text'));
    const a = connect('doc5', 'editor-a');
    await waitFor(() => a.isSynced());

    const unauthorized = await fetch(`${httpUrl}/internal/documents/doc5/restore`, { method: 'POST', body: new Uint8Array() });
    expect(unauthorized.status).toBe(401);

    const res = await fetch(`${httpUrl}/internal/documents/doc5/restore`, {
      method: 'POST',
      headers: { 'x-collab-secret': SECRET, 'content-type': 'application/octet-stream' },
      body: markdownToYUpdate('# Old version\n\nold body'),
    });
    expect(res.status).toBe(204);
    await waitFor(() => yUpdateToMarkdown(Y.encodeStateAsUpdate(a.document)) === '# Old version\n\nold body\n');
    await waitFor(() => yUpdateToMarkdown(api.states.get('doc5')!) === '# Old version\n\nold body\n');
  });

  it('restores a snapshot into a document nobody has open', async () => {
    api.states.set('doc6', markdownToYUpdate('current'));
    const res = await fetch(`${httpUrl}/internal/documents/doc6/restore`, {
      method: 'POST',
      headers: { 'x-collab-secret': SECRET },
      body: markdownToYUpdate('restored'),
    });
    expect(res.status).toBe(204);
    expect(yUpdateToMarkdown(api.states.get('doc6')!)).toBe('restored\n');
  });
  const edit = (id: string, body: unknown) =>
    fetch(`${httpUrl}/internal/documents/${id}/markdown`, {
      method: 'POST',
      headers: { 'x-collab-secret': SECRET, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('applies Markdown edits to an open document and attributes them', async () => {
    api.states.set('doc7', markdownToYUpdate('# Plan\n\nfirst\n\nsecond'));
    const a = connect('doc7', 'editor-a');
    await waitFor(() => a.isSynced());
    const live = () => yUpdateToMarkdown(Y.encodeStateAsUpdate(a.document));

    let res = await edit('doc7', { mode: 'str_replace', find: 'second', replace: 'second, edited', authorId: 'user-x' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { markdown: string }).markdown).toBe('# Plan\n\nfirst\n\nsecond, edited\n');
    await waitFor(() => live() === '# Plan\n\nfirst\n\nsecond, edited\n');

    res = await edit('doc7', { mode: 'append', markdown: '- item', authorId: 'user-x' });
    expect(res.status).toBe(200);
    await waitFor(() => live() === '# Plan\n\nfirst\n\nsecond, edited\n\n- item\n');
    await waitFor(() => (api.storeAuthors.get('doc7') ?? []).includes('user-x'));

    res = await edit('doc7', { mode: 'str_replace', find: 'nope', replace: 'x' });
    expect(res.status).toBe(409);
    res = await edit('doc7', { mode: 'str_replace', find: 'e', replace: 'x' });
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('ambiguous');

    const read = await fetch(`${httpUrl}/internal/documents/doc7/markdown`, { headers: { 'x-collab-secret': SECRET } });
    expect(await read.json()).toEqual({ markdown: live(), live: true });
  });

  it('applies Markdown edits to a document nobody has open', async () => {
    api.states.set('doc8', markdownToYUpdate('old'));
    const res = await edit('doc8', { mode: 'replace', markdown: '## New\n\nbody' });
    expect(res.status).toBe(200);
    expect(yUpdateToMarkdown(api.states.get('doc8')!)).toBe('## New\n\nbody\n');
    const read = await fetch(`${httpUrl}/internal/documents/doc8/markdown`, { headers: { 'x-collab-secret': SECRET } });
    expect(await read.json()).toEqual({ markdown: '## New\n\nbody\n', live: false });
  });
  it('builds comment anchors for quoted text', async () => {
    api.states.set('doc9', markdownToYUpdate('# Title\n\nSome **bold** words here.'));
    const res = await fetch(`${httpUrl}/internal/documents/doc9/anchor`, {
      method: 'POST',
      headers: { 'x-collab-secret': SECRET },
      body: JSON.stringify({ quote: 'bold words' }),
    });
    expect(res.status).toBe(200);
    const { anchor } = (await res.json()) as { anchor: { blockId: string; from: unknown; to: unknown; quote: string } };
    expect(anchor.blockId).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(anchor.quote).toBe('bold words');
    const doc = new Y.Doc();
    Y.applyUpdate(doc, api.states.get('doc9')!);
    const from = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(anchor.from), doc)!;
    const to = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(anchor.to), doc)!;
    expect(to.index - from.index).toBe('bold words'.length);
    const missing = await fetch(`${httpUrl}/internal/documents/doc9/anchor`, {
      method: 'POST',
      headers: { 'x-collab-secret': SECRET },
      body: JSON.stringify({ quote: 'absent' }),
    });
    expect(missing.status).toBe(409);
  });
});
