/**
 * Local playground backend: an in-memory stand-in for apps/api's internal collab endpoints, plus a
 * real collab server in front of it. Every connection's token is "<role>:<userId>" (e.g.
 * "editor:alice"). Used by packages/editor/playground. Not for production.
 *
 *   pnpm --filter @bee/collab exec tsx scripts/dev-fake-api.ts
 */
import { createServer, type IncomingMessage } from 'node:http';
import { createCollabServer } from '../src/server.js';

const API_PORT = Number(process.env.FAKE_API_PORT ?? 18233);
const COLLAB_PORT = Number(process.env.PORT ?? 18234);
const SECRET = 'dev-secret';
const states = new Map<string, Buffer>();

function read(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

createServer(async (req, res) => {
  if (req.headers['x-collab-secret'] !== SECRET) return res.writeHead(401).end();
  const body = await read(req);
  const url = req.url ?? '';
  if (url.endsWith('/auth')) {
    const { shareToken } = JSON.parse(body.toString()) as { shareToken?: string };
    const [role, userId] = (shareToken ?? '').split(':');
    if (!role || !['owner', 'editor', 'commenter', 'viewer'].includes(role)) return res.writeHead(401).end();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ userId: userId ?? null, role }));
  }
  const m = /documents\/([^/]+)\/(state|markdown|versions)$/.exec(url);
  if (!m) return res.writeHead(404).end();
  const [, id, kind] = m as unknown as [string, string, string];
  if (kind === 'state' && req.method === 'GET') {
    const s = states.get(id);
    return s ? res.writeHead(200).end(s) : res.writeHead(204).end();
  }
  if (kind === 'state') states.set(id, body);
  if (kind === 'markdown') console.log(`[fake-api] markdown ${id}:\n${body.toString()}`);
  if (kind === 'versions') console.log(`[fake-api] version of ${id} by ${String(req.headers['x-author-ids'])}`);
  res.writeHead(kind === 'versions' ? 201 : 204).end();
}).listen(API_PORT, () => console.log(`[fake-api] :${API_PORT}`));

const collab = createCollabServer({
  port: COLLAB_PORT,
  apiUrl: `http://127.0.0.1:${API_PORT}`,
  collabSecret: SECRET,
  storeDebounceMs: 1000,
  storeMaxDebounceMs: 5000,
  snapshotIntervalMs: 60_000,
});
await collab.listen();
console.log(`[collab] ws://127.0.0.1:${COLLAB_PORT}/collab`);
