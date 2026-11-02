import { createHash, randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { and, eq, gt } from 'drizzle-orm';
import { sessions, users, type Db } from '@bee/db';
import { SESSION_COOKIE, USER_COLORS } from '@bee/shared';

export type UserRow = typeof users.$inferSelect;

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const SESSION_REFRESH_MS = 15 * 24 * 3600 * 1000;

export function pickColor(seed: string): string {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return USER_COLORS[h % USER_COLORS.length]!;
}

export const hashPassword = (pw: string) =>
  hash(pw, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
export const verifyPassword = (digest: string, pw: string) => verify(digest, pw).catch(() => false);

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function createSession(
  db: Db,
  userId: string,
  meta: { userAgent?: string; ip?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    id: sha256(token),
    userId,
    expiresAt,
    userAgent: meta.userAgent?.slice(0, 300),
    ip: meta.ip,
  });
  return { token, expiresAt };
}

/** Returns the user for a session token, extending the session when it is getting old. */
export async function userForSession(
  db: Db,
  token: string | undefined,
): Promise<{ user: UserRow; refreshedExpiry?: Date } | null> {
  if (!token) return null;
  const id = sha256(token);
  const rows = await db
    .select({ user: users, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.expiresAt.getTime() - Date.now() < SESSION_REFRESH_MS) {
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await db.update(sessions).set({ expiresAt }).where(eq(sessions.id, id));
    return { user: row.user, refreshedExpiry: expiresAt };
  }
  return { user: row.user };
}

export async function deleteSession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sha256(token)));
}

/** Reads the session cookie out of a raw Cookie header (used for collab auth). */
export function sessionTokenFromCookieHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join('='));
  }
  return undefined;
}
