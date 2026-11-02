import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { client, setup, signup, type App } from './helpers.js';

let app: App;
let pool: { end: () => Promise<void> };

beforeAll(async () => {
  ({ app, pool } = await setup({ googleClientId: 'cid', googleClientSecret: 'secret' }));
});
afterAll(async () => {
  await app.close();
  await pool.end();
});
afterEach(() => vi.unstubAllGlobals());

/** Google's token and userinfo endpoints answer with this profile. */
function fakeGoogle(profile: Record<string, unknown>) {
  const real = globalThis.fetch;
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u === 'https://oauth2.googleapis.com/token') {
      expect(String(init?.body)).toContain('code=good-code');
      return Response.json({ access_token: 'at' });
    }
    if (u === 'https://openidconnect.googleapis.com/v1/userinfo') return Response.json(profile);
    return real(url, init);
  });
}

/** Runs the redirect dance; returns the client (now signed in) and where Bee sent it. */
async function googleSignIn(next = '/d/abc') {
  const c = client(app);
  const start = await c.get(`/api/auth/google?next=${encodeURIComponent(next)}`);
  expect(start.status).toBe(302);
  const to = new URL(start.res.headers.location as string);
  expect(to.origin).toBe('https://accounts.google.com');
  const state = to.searchParams.get('state')!;
  const cb = await c.get(`/api/auth/google/callback?code=good-code&state=${state}`);
  return { c, status: cb.status, location: cb.res.headers.location as string };
}

describe('Google sign-in', () => {
  it('reports the provider', async () => {
    const r = await client(app).get('/api/auth/providers');
    expect(r.json).toEqual({ google: true });
  });

  it('a new Google user must set a name and password first', async () => {
    fakeGoogle({ sub: 'g-1', email: 'New.Person@gmail.com', email_verified: true, name: 'New Person' });
    const { c, status, location } = await googleSignIn();
    expect(status).toBe(302);
    expect(location).toBe('/welcome?next=%2Fd%2Fabc');
    const me = await c.get('/api/auth/me');
    expect(me.json.user).toMatchObject({ email: 'new.person@gmail.com', name: 'New Person', setupRequired: true });
    expect(me.json.workspaces).toHaveLength(1);

    // No password yet: password login does not work.
    const bad = await client(app).post('/api/auth/login', { email: 'new.person@gmail.com', password: '' + 'x'.repeat(8) });
    expect(bad.status).toBe(400);

    expect((await c.post('/api/auth/setup', { name: 'Newbie', password: 'short' })).status).toBe(400);
    const done = await c.post('/api/auth/setup', { name: 'Newbie', password: 'password123' });
    expect(done.status).toBe(200);
    expect(done.json.user).toMatchObject({ name: 'Newbie', setupRequired: false });
    expect((await c.post('/api/auth/setup', { name: 'Again', password: 'password123' })).status).toBe(400);

    const login = await client(app).post('/api/auth/login', { email: 'new.person@gmail.com', password: 'password123' });
    expect(login.status).toBe(200);

    // Signing in with Google again goes straight in, to the same account.
    const again = await googleSignIn('/');
    expect(again.location).toBe('/');
    expect((await again.c.get('/api/auth/me')).json.user.id).toBe(me.json.user.id);
  });

  it('links a Google account to the existing user with that email', async () => {
    const { user } = await signup(app, 'linker');
    fakeGoogle({ sub: 'g-2', email: 'linker@example.com', email_verified: true, name: 'Other Name' });
    const { c, location } = await googleSignIn('/');
    expect(location).toBe('/');
    const me = await c.get('/api/auth/me');
    expect(me.json.user).toMatchObject({ id: user.id, name: 'linker', setupRequired: false });
  });

  it('refuses unverified emails and a bad state', async () => {
    fakeGoogle({ sub: 'g-3', email: 'linker@example.com', email_verified: false });
    expect((await googleSignIn()).location).toBe('/login?error=google_unverified');

    const c = client(app);
    await c.get('/api/auth/google');
    const cb = await c.get('/api/auth/google/callback?code=good-code&state=wrong');
    expect(cb.res.headers.location).toBe('/login?error=google_failed');
    expect((await c.get('/api/auth/me')).status).toBe(401);
  });

  it('a cancelled sign-in returns to the login page', async () => {
    const c = client(app);
    const start = await c.get('/api/auth/google');
    const state = new URL(start.res.headers.location as string).searchParams.get('state');
    const cb = await c.get(`/api/auth/google/callback?error=access_denied&state=${state}`);
    expect(cb.res.headers.location).toBe('/login?error=google_cancelled');
  });
});
