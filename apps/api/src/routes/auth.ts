import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { users, workspaceMembers, workspaces, type Db } from '@bee/db';
import { SESSION_COOKIE, type MeResponse } from '@bee/shared';
import type { Config } from '../env.js';
import {
  createSession,
  deleteSession,
  hashPassword,
  pickColor,
  randomToken,
  verifyPassword,
  type UserRow,
} from '../lib/auth.js';
import { badRequest, conflict, forbidden, unauthorized } from '../lib/errors.js';
import { userDTO, workspaceDTO } from '../lib/dto.js';
import { parse } from '../lib/validate.js';

export function setSessionCookie(
  reply: FastifyReply,
  config: Config,
  token: string,
  expires: Date,
) {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.publicUrl.startsWith('https://'),
    expires,
  });
}

export function requireUser(req: FastifyRequest): UserRow {
  if (!req.user) throw unauthorized();
  return req.user;
}

export async function userWorkspaces(db: Db, userId: string) {
  const rows = await db
    .select({ w: workspaces, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(workspaces.createdAt);
  return rows.map((r) => workspaceDTO(r.w, r.role));
}

export function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  return `${base || 'ws'}-${randomToken(4)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, 'x')}`;
}

export async function createWorkspace(db: Db, name: string, ownerId: string) {
  return db.transaction(async (tx) => {
    const [w] = await tx
      .insert(workspaces)
      .values({ name, slug: slugify(name), ownerId })
      .returning();
    await tx
      .insert(workspaceMembers)
      .values({ workspaceId: w!.id, userId: ownerId, role: 'owner' });
    return w!;
  });
}

const email = z
  .email()
  .max(254)
  .transform((s) => s.trim().toLowerCase());
const registerBody = z.object({
  email,
  password: z.string().min(8).max(200),
  name: z.string().trim().min(1).max(80),
});
const loginBody = z.object({ email, password: z.string().min(1).max(200) });
const updateMeBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  avatarUrl: z.url().max(1000).nullable().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});
const passwordBody = z.object({
  currentPassword: z.string(),
  newPassword: z.string().min(8).max(200),
});

export async function authRoutes(app: FastifyInstance) {
  const { db, config } = app;
  const limited = { config: { rateLimit: { max: config.authRateLimit, timeWindow: '1 minute' } } };

  const me = async (user: UserRow): Promise<MeResponse> => ({
    user: userDTO(user),
    workspaces: await userWorkspaces(db, user.id),
  });

  app.post('/auth/register', limited, async (req, reply) => {
    if (!config.allowRegistration) throw forbidden('Registration is disabled');
    const body = parse(registerBody, req.body);
    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${body.email}`)
      .limit(1);
    if (existing.length) throw conflict('An account with this email already exists', 'email_taken');
    const [user] = await db
      .insert(users)
      .values({
        email: body.email,
        name: body.name,
        passwordHash: await hashPassword(body.password),
        color: pickColor(body.email),
      })
      .returning();
    await createWorkspace(db, `${body.name}'s workspace`, user!.id);
    const s = await createSession(db, user!.id, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
    setSessionCookie(reply, config, s.token, s.expiresAt);
    return reply.status(201).send(await me(user!));
  });

  app.post('/auth/login', limited, async (req, reply) => {
    const body = parse(loginBody, req.body);
    const rows = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${body.email}`)
      .limit(1);
    const user = rows[0];
    if (!user || !(await verifyPassword(user.passwordHash, body.password))) {
      throw badRequest('Incorrect email or password', 'invalid_credentials');
    }
    const s = await createSession(db, user.id, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
    });
    setSessionCookie(reply, config, s.token, s.expiresAt);
    return me(user);
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await deleteSession(db, token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/auth/me', async (req) => me(requireUser(req)));

  app.patch('/auth/me', async (req) => {
    const user = requireUser(req);
    const body = parse(updateMeBody, req.body);
    const [u] = await db
      .update(users)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(users.id, user.id))
      .returning();
    return me(u!);
  });

  app.post('/auth/password', limited, async (req) => {
    const user = requireUser(req);
    const body = parse(passwordBody, req.body);
    if (!(await verifyPassword(user.passwordHash, body.currentPassword))) {
      throw badRequest('Current password is incorrect', 'invalid_credentials');
    }
    await db
      .update(users)
      .set({ passwordHash: await hashPassword(body.newPassword), updatedAt: new Date() })
      .where(eq(users.id, user.id));
    return { ok: true };
  });
}
