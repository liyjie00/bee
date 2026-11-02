import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { bugReports } from '@bee/db';
import { client, setup, signup, type App } from './helpers.js';

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

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function form(fields: Record<string, string>, files: { name: string; type: string; data: Buffer }[] = []) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const f of files) fd.append('images', new Blob([new Uint8Array(f.data)], { type: f.type }), f.name);
  const r = new Response(fd);
  return { payload: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type')! };
}

describe('bug reports', () => {
  it('saves the report with its images and emails it to the team', async () => {
    const nodemailer = (await import('nodemailer')).default;
    const { setMailer } = await import('../src/lib/delivery.js');
    const sent: { to: string; subject: string; replyTo: unknown; attachments: unknown[] }[] = [];
    const t = nodemailer.createTransport({ jsonTransport: true });
    const send = t.sendMail.bind(t);
    t.sendMail = (async (m: (typeof sent)[number]) => {
      sent.push(m);
      return send(m as never);
    }) as never;
    setMailer(t);
    try {
      const ann = await signup(app, 'bugann');
      const f = await form(
        { body: 'Tab jumps to the title\nsteps: 1. 2.', meta: JSON.stringify({ url: 'https://x/d/1', viewport: '1440×900', junk: { a: 1 } }) },
        [
          { name: 'a.png', type: 'image/png', data: PNG },
          { name: 'b.png', type: 'image/png', data: PNG },
        ],
      );
      const r = await ann.c.post('/api/bug-reports', f.payload, { 'content-type': f.type });
      expect(r.status).toBe(201);
      const [row] = await app.db.select().from(bugReports).where(eq(bugReports.id, r.json.id));
      expect(row!.body).toBe('Tab jumps to the title\nsteps: 1. 2.');
      expect(row!.email).toBe('bugann@example.com');
      expect(row!.meta).toEqual({ url: 'https://x/d/1', viewport: '1440×900' });
      expect(row!.images.map((i) => i.filename)).toEqual(['a.png', 'b.png']);
      expect(row!.emailedAt).not.toBeNull();
      expect(sent).toHaveLength(1);
      expect(sent[0]!.to).toBe('contactus@bee.zippyzoo.dev');
      expect(sent[0]!.subject).toBe(`[Bee Bug #${r.json.id}] Tab jumps to the title`);
      expect(sent[0]!.replyTo).toEqual({ name: 'bugann', address: 'bugann@example.com' });
      expect(sent[0]!.attachments).toHaveLength(2);
    } finally {
      setMailer(null);
    }
  });

  it('still saves the report when email is off', async () => {
    const bo = await signup(app, 'bugbo');
    const f = await form({ body: 'Broken' });
    const r = await bo.c.post('/api/bug-reports', f.payload, { 'content-type': f.type });
    expect(r.status).toBe(201);
    const [row] = await app.db.select().from(bugReports).where(eq(bugReports.id, r.json.id));
    expect(row!.emailedAt).toBeNull();
    expect(row!.images).toEqual([]);
  });

  it('rejects empty reports, non-images, too many images and guests', async () => {
    const cy = await signup(app, 'bugcy');
    let f = await form({ body: '   ' });
    expect((await cy.c.post('/api/bug-reports', f.payload, { 'content-type': f.type })).status).toBe(400);
    f = await form({ body: 'x' }, [{ name: 'a.txt', type: 'text/plain', data: Buffer.from('hi') }]);
    expect((await cy.c.post('/api/bug-reports', f.payload, { 'content-type': f.type })).status).toBe(400);
    f = await form(
      { body: 'x' },
      Array.from({ length: 6 }, (_, i) => ({ name: `${i}.png`, type: 'image/png', data: PNG })),
    );
    expect((await cy.c.post('/api/bug-reports', f.payload, { 'content-type': f.type })).status).toBe(413);
    f = await form({ body: 'x' });
    expect((await client(app).post('/api/bug-reports', f.payload, { 'content-type': f.type })).status).toBe(401);
  });
});
