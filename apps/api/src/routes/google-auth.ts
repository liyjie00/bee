import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { users, type Db } from '@bee/db';
import type { AuthProvidersResponse } from '@bee/shared';
import { clientIp } from '../lib/ip.js';
import { createSession, hashPassword, pickColor, randomToken, type UserRow } from '../lib/auth.js';
import { badRequest } from '../lib/errors.js';
import { userDTO } from '../lib/dto.js';
import { parse } from '../lib/validate.js';
import { createWorkspace, requireUser, setSessionCookie, userWorkspaces } from './auth.js';

const STATE_COOKIE = 'bee_google_oauth';
const COOKIE_PATH = '/api/auth/google';

interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name: string | null;
  picture: string | null;
}

const setupBody = z.object({
  name: z.string().trim().min(1).max(80),
  password: z.string().min(8).max(200),
});

/** Only same-site paths, so the callback cannot redirect elsewhere. */
function safeNext(next: unknown): string {
  return typeof next === 'string' && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')
    ? next
    : '/';
}

/**
 * The Bee user for a Google account: the one already linked to it, else the one with the
 * same (Google-verified) email, which gets linked, else a new user who still has to pick
 * a name and password (setupRequired). null when sign-ups are off and there is no match.
 */
export async function userForGoogle(db: Db, p: GoogleProfile, allowRegistration: boolean): Promise<UserRow | null> {
  const [linked] = await db.select().from(users).where(eq(users.googleSub, p.sub)).limit(1);
  if (linked) return linked;
  const email = p.email.trim().toLowerCase();
  const [byEmail] = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${email}`)
    .limit(1);
  if (byEmail) {
    const [u] = await db
      .update(users)
      .set({ googleSub: p.sub, avatarUrl: byEmail.avatarUrl ?? p.picture, updatedAt: new Date() })
      .where(eq(users.id, byEmail.id))
      .returning();
    return u!;
  }
  if (!allowRegistration) return null;
  const name = (p.name?.trim() || email.split('@')[0]!).slice(0, 80);
  const [user] = await db
    .insert(users)
    .values({
      email,
      name,
      // No password until setup; an empty hash never verifies.
      passwordHash: '',
      googleSub: p.sub,
      setupRequired: true,
      avatarUrl: p.picture,
      color: pickColor(email),
    })
    .returning();
  await createWorkspace(db, `${name}'s workspace`, user!.id);
  return user!;
}

export async function googleAuthRoutes(app: FastifyInstance) {
  const { db, config } = app;
  const enabled = !!(config.googleClientId && config.googleClientSecret);
  const redirectUri = `${config.publicUrl}/api/auth/google/callback`;
  const limited = { config: { rateLimit: { max: config.authRateLimit, timeWindow: '1 minute' } } };

  app.get('/auth/providers', async (): Promise<AuthProvidersResponse> => ({ google: enabled }));

  app.get('/auth/google', limited, async (req, reply) => {
    const next = safeNext((req.query as { next?: unknown }).next);
    if (!enabled) return reply.redirect('/login?error=google_unavailable');
    const state = randomToken(16);
    reply.setCookie(STATE_COOKIE, JSON.stringify({ state, next }), {
      path: COOKIE_PATH,
      httpOnly: true,
      sameSite: 'lax',
      secure: config.publicUrl.startsWith('https://'),
      maxAge: 600,
      signed: true,
    });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', config.googleClientId!);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('prompt', 'select_account');
    return reply.redirect(url.toString());
  });

  app.get('/auth/google/callback', limited, async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string };
    const raw = req.cookies[STATE_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : null;
    reply.clearCookie(STATE_COOKIE, { path: COOKIE_PATH });
    let saved: { state: string; next: string } | null;
    try {
      saved = unsigned?.valid && unsigned.value ? JSON.parse(unsigned.value) : null;
    } catch {
      saved = null;
    }
    const fail = (code: string) => reply.redirect(`/login?error=${code}`);
    if (!enabled) return fail('google_unavailable');
    // No code: the user cancelled on Google's page.
    if (!saved || !q.code || q.state !== saved.state) return fail(q.error ? 'google_cancelled' : 'google_failed');
    let profile: GoogleProfile;
    try {
      profile = await fetchProfile(q.code);
    } catch (err) {
      req.log.warn({ err }, 'google sign-in failed');
      return fail('google_failed');
    }
    if (!profile.emailVerified) return fail('google_unverified');
    const user = await userForGoogle(db, profile, config.allowRegistration);
    if (!user) return fail('registration_disabled');
    const s = await createSession(db, user.id, { userAgent: req.headers['user-agent'], ip: clientIp(req) });
    setSessionCookie(reply, config, s.token, s.expiresAt);
    const next = safeNext(saved.next);
    return reply.redirect(user.setupRequired ? `/welcome?next=${encodeURIComponent(next)}` : next);
  });

  app.post('/auth/setup', limited, async (req) => {
    const user = requireUser(req);
    if (!user.setupRequired) throw badRequest('This account is already set up', 'already_set_up');
    const body = parse(setupBody, req.body);
    const [u] = await db
      .update(users)
      .set({ name: body.name, passwordHash: await hashPassword(body.password), setupRequired: false, updatedAt: new Date() })
      .where(eq(users.id, user.id))
      .returning();
    return { user: userDTO(u!), workspaces: await userWorkspaces(db, u!.id) };
  });

  async function fetchProfile(code: string): Promise<GoogleProfile> {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: config.googleClientId!,
        client_secret: config.googleClientSecret!,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const token = (await tokenRes.json().catch(() => null)) as { access_token?: string } | null;
    if (!tokenRes.ok || !token?.access_token) throw new Error(`token exchange failed: ${tokenRes.status}`);
    // Read from Google over TLS with the fresh access token, so the id_token needs no signature check.
    const infoRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${token.access_token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const info = (await infoRes.json().catch(() => null)) as {
      sub?: string;
      email?: string;
      email_verified?: boolean;
      name?: string;
      picture?: string;
    } | null;
    if (!infoRes.ok || !info?.sub || !info.email) throw new Error(`userinfo failed: ${infoRes.status}`);
    return {
      sub: info.sub,
      email: info.email,
      emailVerified: info.email_verified === true,
      name: info.name ?? null,
      picture: info.picture && info.picture.length <= 1000 ? info.picture : null,
    };
  }
}
