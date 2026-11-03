import { and, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { comments, permissions, users, workspaceMembers, type Db } from '@bee/db';
import {
  can,
  effectiveRole,
  roleAtLeast,
  type ChainNode,
  type NotificationKind,
  type Role,
} from '@bee/shared';
import type { DocAccess } from './access.js';
import { insertNotifications } from './delivery.js';

export interface Reader {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  color: string;
}

/**
 * Signed-in users who can read the document (workspace members, people it is shared with, owners),
 * or who have at least `minRole`.
 */
export async function docReaders(
  db: Db,
  a: DocAccess,
  opts: { minRole?: Role } = {},
): Promise<Reader[]> {
  const ids = [a.doc.id, ...a.chain.map((f) => f.id)];
  const [members, grants] = await Promise.all([
    db
      .select({ userId: workspaceMembers.userId, role: workspaceMembers.role })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.workspaceId, a.doc.workspaceId)),
    db.select().from(permissions).where(inArray(permissions.resourceId, ids)),
  ]);
  const memberRole = new Map(members.map((m) => [m.userId, m.role]));
  const grantsOf = (id: string) =>
    grants
      .filter((g) => g.resourceId === id)
      .map((g) => ({ principalType: g.principalType, principalId: g.principalId, role: g.role }));
  const chain: ChainNode[] = [
    { type: 'document', id: a.doc.id, ownerId: a.doc.ownerId, grants: grantsOf(a.doc.id) },
    ...a.chain.map((f) => ({
      type: 'folder' as const,
      id: f.id,
      ownerId: f.ownerId,
      grants: grantsOf(f.id),
      restricted: f.restricted,
    })),
  ];
  const candidates = new Set<string>([
    ...memberRole.keys(),
    ...chain.map((n) => n.ownerId),
    ...grants.filter((g) => g.principalType === 'user').map((g) => g.principalId),
  ]);
  const readable = [...candidates].filter((userId) => {
    const role = effectiveRole({
      userId,
      workspaceId: a.doc.workspaceId,
      workspaceRole: memberRole.get(userId) ?? null,
      team: a.team,
      chain,
    });
    return opts.minRole ? roleAtLeast(role, opts.minRole) : can.read(role);
  });
  if (!readable.length) return [];
  return db
    .select({
      id: users.id,
      name: users.name,
      email: users.email,
      avatarUrl: users.avatarUrl,
      color: users.color,
    })
    .from(users)
    .where(inArray(users.id, readable));
}

/** Readers whose "@name" appears in the text; longer names win, so "@Ann Lee" is not also "@Ann". */
export function mentionedIn(text: string, readers: Reader[]): Reader[] {
  let rest = text;
  const found: Reader[] = [];
  for (const r of [...readers].sort((x, y) => y.name.length - x.name.length)) {
    const tag = '@' + r.name;
    if (!r.name || !rest.includes(tag)) continue;
    found.push(r);
    rest = rest.split(tag).join(' ');
  }
  return found;
}

const excerpt = (s: string) => (s.length > 280 ? s.slice(0, 279) + '…' : s);

/**
 * After a comment is posted: notifies people it @mentions, and (for replies) the others who took
 * part in the thread. Never notifies the author; people without read access are skipped.
 */
export function notifyComment(...args: Parameters<typeof commentNotifications>): Promise<void> {
  // A failed notification must not fail the comment that was already saved.
  return commentNotifications(...args).catch((err) => console.error('notifyComment failed', err));
}

async function commentNotifications(
  db: Db,
  a: DocAccess,
  c: {
    threadId: string;
    commentId: string;
    actorId: string | null;
    actorName: string | null;
    body: string;
    reply: boolean;
  },
): Promise<void> {
  const readers = await docReaders(db, a);
  const canRead = new Set(readers.map((r) => r.id));
  const rows = new Map<string, NotificationKind>();
  for (const r of mentionedIn(c.body, readers)) rows.set(r.id, 'mention');
  if (c.reply) {
    const earlier = await db
      .selectDistinct({ id: comments.authorId })
      .from(comments)
      .where(
        and(
          eq(comments.threadId, c.threadId),
          isNotNull(comments.authorId),
          ne(comments.id, c.commentId),
        ),
      );
    for (const e of earlier) if (e.id && !rows.has(e.id)) rows.set(e.id, 'reply');
  }
  if (c.actorId) rows.delete(c.actorId);
  const values = [...rows]
    .filter(([userId]) => canRead.has(userId))
    .map(([userId, kind]) => ({
      userId,
      workspaceId: a.doc.workspaceId,
      kind,
      documentId: a.doc.id,
      threadId: c.threadId,
      actorId: c.actorId,
      actorName: c.actorName,
      detail: excerpt(c.body),
    }));
  await insertNotifications(db, values);
}

export async function notifyShare(
  db: Db,
  n: {
    userId: string;
    actorId: string;
    workspaceId: string;
    documentId?: string;
    folderId?: string;
    role: string;
  },
): Promise<void> {
  if (n.userId === n.actorId) return;
  await insertNotifications(db, [
    {
      userId: n.userId,
      workspaceId: n.workspaceId,
      kind: 'share',
      documentId: n.documentId ?? null,
      folderId: n.folderId ?? null,
      actorId: n.actorId,
      detail: n.role,
    },
  ]);
}
