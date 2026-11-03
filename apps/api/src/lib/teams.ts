/* Team workspaces: invitations, membership changes, and moving content between workspaces. */
import { and, asc, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  activity,
  documents,
  folders,
  notifications,
  permissions,
  uploads,
  users,
  workspaceInvites,
  workspaceMembers,
  workspaces,
  type Db,
} from '@bee/db';
import type { InviteRole, TeamInviteDTO, WorkspaceRole } from '@bee/shared';
import { randomToken } from './auth.js';
import { insertNotifications, langOf, sendInviteEmail } from './delivery.js';
import { loadUserRefs } from './dto.js';
import { badRequest, notFound } from './errors.js';
import { sha256 } from './tokens.js';

export type WorkspaceRow = typeof workspaces.$inferSelect;
type InviteRow = typeof workspaceInvites.$inferSelect;

export const INVITE_TTL_MS = 7 * 24 * 3600_000;

export const invitePath = (token: string) => `/invite/${token}`;

export async function requireTeam(db: Db, workspaceId: string): Promise<WorkspaceRow> {
  const [w] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!w) throw notFound('Workspace not found');
  if (w.kind !== 'team') throw badRequest('Only team workspaces have members');
  return w;
}

export async function inviteDTOs(db: Db, rows: InviteRow[]): Promise<TeamInviteDTO[]> {
  const refs = await loadUserRefs(
    db,
    rows.map((r) => r.invitedById),
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    invitedBy: r.invitedById ? (refs.get(r.invitedById) ?? null) : null,
    createdAt: r.createdAt.toISOString(),
    expiresAt: r.expiresAt.toISOString(),
  }));
}

/** Pending, unexpired invitations of a team. */
export async function pendingInvites(db: Db, workspaceId: string): Promise<InviteRow[]> {
  return db
    .select()
    .from(workspaceInvites)
    .where(
      and(
        eq(workspaceInvites.workspaceId, workspaceId),
        sql`${workspaceInvites.acceptedAt} is null and ${workspaceInvites.revokedAt} is null and ${workspaceInvites.expiresAt} > now()`,
      ),
    )
    .orderBy(asc(workspaceInvites.createdAt));
}

/**
 * Invites people by email: a pending invitation per address (renewed if one exists), an email with
 * the link, and an in-app notification for people who already have an account. Members are skipped.
 * Returns each invitation with its link, so it can be copied when email is off.
 */
export async function inviteByEmail(
  db: Db,
  opts: {
    team: WorkspaceRow;
    emails: string[];
    role: InviteRole;
    inviter: { id: string; name: string };
    publicUrl: string;
  },
): Promise<{ invite: InviteRow; url: string; emailed: boolean }[]> {
  const emails = [...new Set(opts.emails.map((e) => e.trim().toLowerCase()))];
  if (!emails.length) return [];
  const existing = await db
    .select({ id: users.id, email: users.email, prefs: users.prefs })
    .from(users)
    .where(inArray(sql`lower(${users.email})`, emails));
  const byEmail = new Map(existing.map((u) => [u.email.toLowerCase(), u]));
  const members = new Set(
    (
      await db
        .select({ userId: workspaceMembers.userId })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.workspaceId, opts.team.id))
    ).map((m) => m.userId),
  );
  const out: { invite: InviteRow; url: string; emailed: boolean }[] = [];
  for (const email of emails) {
    const user = byEmail.get(email);
    if (user && members.has(user.id)) continue;
    const token = randomToken(24);
    const values = {
      role: opts.role,
      tokenHash: sha256(token),
      invitedById: opts.inviter.id,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    };
    // One pending invitation per address: inviting again renews it with a fresh link.
    await db
      .update(workspaceInvites)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(workspaceInvites.workspaceId, opts.team.id),
          sql`lower(${workspaceInvites.email}) = ${email}`,
          sql`${workspaceInvites.acceptedAt} is null and ${workspaceInvites.revokedAt} is null`,
        ),
      );
    const [invite] = await db
      .insert(workspaceInvites)
      .values({ ...values, workspaceId: opts.team.id, email })
      .returning();
    const url = opts.publicUrl + invitePath(token);
    const emailed = await sendInviteEmail({
      to: email,
      inviter: opts.inviter.name,
      team: opts.team.name,
      role: opts.role,
      url,
      lang: langOf(user?.prefs),
    });
    if (user)
      await insertNotifications(db, [
        {
          userId: user.id,
          workspaceId: opts.team.id,
          kind: 'team_invite',
          actorId: opts.inviter.id,
          detail: opts.role,
          // the invitation email already went out
          emailedAt: new Date(),
        },
      ]);
    out.push({ invite: invite!, url, emailed });
  }
  return out;
}

export type InviteTarget =
  | { kind: 'email'; team: WorkspaceRow; invite: InviteRow; role: InviteRole }
  | { kind: 'link'; team: WorkspaceRow; role: InviteRole };

/** What an invitation token opens: an email invitation, or a team's join link. */
export async function resolveInvite(db: Db, token: string): Promise<InviteTarget | null> {
  const [invite] = await db
    .select()
    .from(workspaceInvites)
    .where(eq(workspaceInvites.tokenHash, sha256(token)))
    .limit(1);
  if (invite) {
    if (invite.acceptedAt || invite.revokedAt || invite.expiresAt.getTime() < Date.now())
      return null;
    const [team] = await db
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, invite.workspaceId))
      .limit(1);
    return team ? { kind: 'email', team, invite, role: invite.role } : null;
  }
  const [team] = await db
    .select()
    .from(workspaces)
    .where(and(eq(workspaces.linkToken, token), eq(workspaces.kind, 'team')))
    .limit(1);
  return team ? { kind: 'link', team, role: team.linkRole } : null;
}

export async function memberCount(db: Db, workspaceId: string): Promise<number> {
  const [r] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.workspaceId, workspaceId));
  return r?.n ?? 0;
}

/** Adds a member (keeping the role they have if they are one), and clears their invitation notices. */
export async function addMember(db: Db, workspaceId: string, userId: string, role: WorkspaceRole) {
  await db
    .insert(workspaceMembers)
    .values({ workspaceId, userId, role })
    .onConflictDoNothing();
  await db
    .update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.userId, userId),
        eq(notifications.workspaceId, workspaceId),
        eq(notifications.kind, 'team_invite'),
        sql`${notifications.readAt} is null`,
      ),
    );
}

async function ownerIds(db: Db, workspaceId: string): Promise<string[]> {
  const rows = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.role, 'owner')))
    .orderBy(asc(workspaceMembers.createdAt));
  return rows.map((r) => r.userId);
}

/** Throws unless someone other than `userId` stays an owner of the team. */
export async function requireAnotherOwner(db: Db, workspaceId: string, userId: string) {
  if (!(await ownerIds(db, workspaceId)).some((id) => id !== userId))
    throw badRequest('A team needs at least one owner. Make someone else an owner first.');
}

/**
 * Removes a member. What they created stays in the team, owned by `heirId` (or the earliest
 * remaining owner), and their personal grants on team content go, so nothing stays reachable.
 */
export async function removeMember(
  db: Db,
  workspaceId: string,
  userId: string,
  heirId?: string,
): Promise<void> {
  const heir = heirId && heirId !== userId ? heirId : (await ownerIds(db, workspaceId)).find((id) => id !== userId);
  if (!heir) throw badRequest('A team needs at least one owner. Make someone else an owner first.');
  await db.transaction(async (tx) => {
    await tx
      .update(folders)
      .set({ ownerId: heir })
      .where(and(eq(folders.workspaceId, workspaceId), eq(folders.ownerId, userId)));
    await tx
      .update(documents)
      .set({ ownerId: heir })
      .where(and(eq(documents.workspaceId, workspaceId), eq(documents.ownerId, userId)));
    await tx
      .delete(permissions)
      .where(
        and(
          eq(permissions.workspaceId, workspaceId),
          eq(permissions.principalType, 'user'),
          eq(permissions.principalId, userId),
        ),
      );
    await tx
      .update(workspaces)
      .set({ ownerId: heir })
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.ownerId, userId)));
    await tx
      .delete(workspaceMembers)
      .where(
        and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)),
      );
  });
}

/** Ids of the folder and every folder below it. */
async function subtreeFolders(db: Db, folderId: string): Promise<string[]> {
  const res = await db.execute<{ id: string }>(sql`
    with recursive sub as (
      select id, 0 as depth from folders where id = ${folderId}
      union all select f.id, s.depth + 1 from folders f join sub s on f.parent_id = s.id
      where s.depth < 64
    )
    select id from sub`);
  return res.rows.map((r) => r.id);
}

/** The documents and every document embedded in them (whiteboards inside docs, ...). */
async function withEmbedded(db: Db, docIds: string[]): Promise<string[]> {
  if (!docIds.length) return [];
  const res = await db.execute<{ id: string }>(sql`
    with recursive sub as (
      select id, 0 as depth from documents where id in (${sql.join(
        docIds.map((id) => sql`${id}`),
        sql`, `,
      )})
      union all select d.id, s.depth + 1 from documents d join sub s on d.parent_document_id = s.id
      where s.depth < 16
    )
    select distinct id from sub`);
  return res.rows.map((r) => r.id);
}

/**
 * Moves a document or folder (with everything inside it) to another workspace. Personal grants and
 * share links travel with it; grants to the old workspace's members do not.
 */
export async function moveToWorkspace(
  db: Db,
  item: { type: 'document' | 'folder'; id: string; from: string },
  to: { workspaceId: string; folderId: string | null; sort: number },
): Promise<void> {
  const folderIds = item.type === 'folder' ? await subtreeFolders(db, item.id) : [];
  const topDocs =
    item.type === 'document'
      ? [item.id]
      : folderIds.length
        ? (
            await db
              .select({ id: documents.id })
              .from(documents)
              .where(inArray(documents.folderId, folderIds))
          ).map((d) => d.id)
        : [];
  const docIds = await withEmbedded(db, topDocs);
  const resourceIds = [...folderIds, ...docIds];
  await db.transaction(async (tx) => {
    if (item.type === 'folder') {
      await tx
        .update(folders)
        .set({ parentId: to.folderId, sort: to.sort, updatedAt: new Date() })
        .where(eq(folders.id, item.id));
      await tx
        .update(folders)
        .set({ workspaceId: to.workspaceId })
        .where(inArray(folders.id, folderIds));
    } else {
      await tx
        .update(documents)
        .set({ folderId: to.folderId, sort: to.sort, updatedAt: new Date() })
        .where(eq(documents.id, item.id));
    }
    if (docIds.length) {
      await tx
        .update(documents)
        .set({ workspaceId: to.workspaceId })
        .where(inArray(documents.id, docIds));
      await tx
        .update(uploads)
        .set({ workspaceId: to.workspaceId })
        .where(inArray(uploads.documentId, docIds));
      await tx
        .update(activity)
        .set({ workspaceId: to.workspaceId })
        .where(inArray(activity.documentId, docIds));
      await tx
        .update(notifications)
        .set({ workspaceId: to.workspaceId })
        .where(inArray(notifications.documentId, docIds));
    }
    if (resourceIds.length) {
      await tx
        .delete(permissions)
        .where(
          and(
            inArray(permissions.resourceId, resourceIds),
            eq(permissions.principalType, 'workspace'),
          ),
        );
      await tx
        .update(permissions)
        .set({ workspaceId: to.workspaceId })
        .where(and(inArray(permissions.resourceId, resourceIds), ne(permissions.principalType, 'workspace')));
    }
  });
}
