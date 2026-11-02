import { createHash } from 'node:crypto';
import { and, eq, gt, isNull, lt, or } from 'drizzle-orm';
import { apiTokens, users, type Db } from '@bee/db';
import { randomToken, type UserRow } from './auth.js';

export type TokenKind = (typeof apiTokens.$inferSelect)['kind'];
export type TokenRow = typeof apiTokens.$inferSelect;

const PREFIX: Record<TokenKind, string> = {
  personal: 'bee_pat_',
  oauth_access: 'bee_oat_',
  oauth_refresh: 'bee_ort_',
};

export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 90 * 24 * 3600 * 1000;
const LAST_USED_RESOLUTION_MS = 5 * 60 * 1000;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function issueToken(
  db: Db,
  v: {
    userId: string;
    kind: TokenKind;
    name: string;
    clientId?: string | null;
    grantId?: string | null;
    ttlMs?: number | null;
  },
): Promise<{ token: string; row: TokenRow }> {
  const token = PREFIX[v.kind] + randomToken(32);
  const [row] = await db
    .insert(apiTokens)
    .values({
      id: sha256(token),
      userId: v.userId,
      kind: v.kind,
      name: v.name.slice(0, 100),
      prefix: token.slice(0, PREFIX[v.kind].length + 4),
      clientId: v.clientId ?? null,
      grantId: v.grantId ?? null,
      expiresAt: v.ttlMs ? new Date(Date.now() + v.ttlMs) : null,
    })
    .returning();
  return { token, row: row! };
}

/** Looks up a live token of one of `kinds`. */
export async function findToken(
  db: Db,
  token: string,
  kinds: TokenKind[],
): Promise<{ row: TokenRow; user: UserRow } | null> {
  const kind = kinds.find((k) => token.startsWith(PREFIX[k]));
  if (!kind) return null;
  const rows = await db
    .select({ row: apiTokens, user: users })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(
      and(
        eq(apiTokens.id, sha256(token)),
        eq(apiTokens.kind, kind),
        or(isNull(apiTokens.expiresAt), gt(apiTokens.expiresAt, new Date())),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Resolves an `Authorization: Bearer` access token (personal or OAuth) to its user. */
export async function userForBearer(db: Db, token: string) {
  const hit = await findToken(db, token, ['personal', 'oauth_access']);
  if (!hit) return null;
  const now = Date.now();
  if (!hit.row.lastUsedAt || now - hit.row.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
    await db
      .update(apiTokens)
      .set({ lastUsedAt: new Date(now) })
      .where(eq(apiTokens.id, hit.row.id));
  }
  return hit;
}

export function bearerFrom(header: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m?.[1] ?? null;
}

/** Drops expired OAuth tokens (personal tokens without expiry are kept). */
export async function pruneTokens(db: Db) {
  await db.delete(apiTokens).where(lt(apiTokens.expiresAt, new Date()));
}
