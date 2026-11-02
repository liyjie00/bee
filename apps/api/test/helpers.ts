import { sql } from 'drizzle-orm';
import { createDb, runMigrations } from '@bee/db';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/env.js';

export const TEST_DB =
  process.env.TEST_DATABASE_URL ?? 'postgres://bee:bee@localhost:54329/bee_test';

export async function setup() {
  await runMigrations(TEST_DB);
  const { db, pool } = createDb(TEST_DB);
  await db.execute(sql`truncate users, workspaces cascade`);
  const config = {
    ...loadConfig({ NODE_ENV: 'test', DATABASE_URL: TEST_DB }),
    collabSecret: 'test-secret',
    authRateLimit: 1000,
    uploadDir: './data/test-uploads',
    collabInternalUrl: 'http://127.0.0.1:9',
  };
  const app = await buildApp({ db, config });
  return { app, db, pool, config };
}

export type App = Awaited<ReturnType<typeof setup>>['app'];

/** Minimal cookie-jar client around app.inject. */
export function client(app: App) {
  let cookie = '';
  const call = async (
    method: string,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.inject({
      method: method as 'GET',
      url,
      payload: body as object | undefined,
      headers: { ...(cookie ? { cookie } : {}), ...headers },
    });
    const set = res.headers['set-cookie'];
    const first = Array.isArray(set) ? set[0] : set;
    if (first) cookie = first.split(';')[0]!;
    let json: any = null;
    try {
      json = res.json();
    } catch {
      /* not json */
    }
    return { status: res.statusCode, json, res };
  };
  return {
    get: (u: string, h?: Record<string, string>) => call('GET', u, undefined, h),
    post: (u: string, b?: unknown, h?: Record<string, string>) => call('POST', u, b ?? {}, h),
    patch: (u: string, b?: unknown) => call('PATCH', u, b ?? {}),
    del: (u: string) => call('DELETE', u),
    get cookie() {
      return cookie;
    },
  };
}

export async function signup(app: App, name: string) {
  const c = client(app);
  const r = await c.post('/api/auth/register', {
    email: `${name}@example.com`,
    password: 'password123',
    name,
  });
  if (r.status !== 201) throw new Error(`register failed: ${JSON.stringify(r.json)}`);
  return { c, user: r.json.user, workspace: r.json.workspaces[0] };
}
