import type { FastifyInstance } from 'fastify';
import { and, eq, max, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { documents, folders, workspaceInvites, workspaces, type Db } from '@bee/db';
import {
  can,
  INVITE_ROLES,
  workspaceRoleAtLeast,
  type InvitePreviewDTO,
  type TeamLinkDTO,
} from '@bee/shared';
import { docAccess, folderAccess, folderChain, membershipRole, requireMember } from '../lib/access.js';
import { logActivity } from '../lib/activity.js';
import { randomToken } from '../lib/auth.js';
import { badRequest, forbidden, HttpError, notFound, unauthorized } from '../lib/errors.js';
import { loadUserRefs, workspaceDTO } from '../lib/dto.js';
import {
  addMember,
  inviteByEmail,
  inviteDTOs,
  invitePath,
  memberCount,
  moveToWorkspace,
  pendingInvites,
  requireTeam,
  resolveInvite,
  type WorkspaceRow,
} from '../lib/teams.js';
import { idParams, parse } from '../lib/validate.js';
import { requireUser } from './auth.js';
import { requireCreateIn } from './folders.js';

const inviteParams = z.object({ id: z.uuid(), inviteId: z.uuid() });
const tokenParams = z.object({ token: z.string().min(8).max(100) });
const moveBody = z.object({ workspaceId: z.uuid(), folderId: z.uuid().nullable().optional() });

async function nextSort(db: Db, table: 'folders' | 'documents', ws: string, parent: string | null) {
  const t = table === 'folders' ? folders : documents;
  const col = table === 'folders' ? folders.parentId : documents.folderId;
  const [r] = await db
    .select({ m: max(t.sort) })
    .from(t)
    .where(and(eq(t.workspaceId, ws), parent ? eq(col, parent) : isNull(col)));
  return (r?.m ?? 0) + 1;
}

export async function teamRoutes(app: FastifyInstance) {
  const { db, config } = app;

  const linkDTO = (w: WorkspaceRow): TeamLinkDTO => ({
    url: w.linkToken ? config.publicUrl + invitePath(w.linkToken) : null,
    role: w.linkRole,
  });

  /** Team members see pending invitations; editors and owners manage them. */
  app.get('/workspaces/:id/invites', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const role = await requireMember(db, id, user.id);
    const team = await requireTeam(db, id);
    const invites = await inviteDTOs(db, await pendingInvites(db, id));
    return { invites, link: workspaceRoleAtLeast(role, 'editor') ? linkDTO(team) : null };
  });

  const manageInvite = async (workspaceId: string, inviteId: string, userId: string) => {
    const role = await requireMember(db, workspaceId, userId);
    if (!workspaceRoleAtLeast(role, 'editor')) throw forbidden();
    const [inv] = await db
      .select()
      .from(workspaceInvites)
      .where(and(eq(workspaceInvites.id, inviteId), eq(workspaceInvites.workspaceId, workspaceId)));
    if (!inv || inv.acceptedAt || inv.revokedAt) throw notFound('Invitation not found');
    return inv;
  };

  /** Sends a fresh link (the old one stops working) and restarts the 7 days. */
  app.post('/workspaces/:id/invites/:inviteId/resend', async (req) => {
    const user = requireUser(req);
    const { id, inviteId } = parse(inviteParams, req.params);
    const inv = await manageInvite(id, inviteId, user.id);
    const team = await requireTeam(db, id);
    const [sent] = await inviteByEmail(db, {
      team,
      emails: [inv.email],
      role: inv.role,
      inviter: user,
      publicUrl: config.publicUrl,
    });
    return { invite: sent ? { email: inv.email, url: sent.url, emailed: sent.emailed } : null };
  });

  app.delete('/workspaces/:id/invites/:inviteId', async (req) => {
    const user = requireUser(req);
    const { id, inviteId } = parse(inviteParams, req.params);
    await manageInvite(id, inviteId, user.id);
    await db
      .update(workspaceInvites)
      .set({ revokedAt: new Date() })
      .where(eq(workspaceInvites.id, inviteId));
    return { ok: true };
  });

  /** Owners turn the join link on or off and choose the role it gives. */
  app.patch('/workspaces/:id/link', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const body = parse(
      z.object({ enabled: z.boolean().optional(), role: z.enum(INVITE_ROLES).optional() }),
      req.body,
    );
    const role = await requireMember(db, id, user.id);
    const team = await requireTeam(db, id);
    if (role !== 'owner') throw forbidden('Only owners can change the invite link');
    const patch: Partial<WorkspaceRow> = {};
    if (body.role) patch.linkRole = body.role;
    if (body.enabled === false) patch.linkToken = null;
    if (body.enabled && !team.linkToken) patch.linkToken = randomToken(9);
    if (!Object.keys(patch).length) return { link: linkDTO(team) };
    const [w] = await db.update(workspaces).set(patch).where(eq(workspaces.id, id)).returning();
    return { link: linkDTO(w!) };
  });

  /** A new join link; the old one stops working. */
  app.post('/workspaces/:id/link/reset', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const role = await requireMember(db, id, user.id);
    await requireTeam(db, id);
    if (role !== 'owner') throw forbidden('Only owners can reset the invite link');
    const [w] = await db
      .update(workspaces)
      .set({ linkToken: randomToken(9) })
      .where(eq(workspaces.id, id))
      .returning();
    return { link: linkDTO(w!) };
  });

  /** What an invitation link opens. Works signed out, so the page can offer to sign up. */
  app.get('/invites/:token', async (req) => {
    const { token } = parse(tokenParams, req.params);
    const target = await resolveInvite(db, token);
    if (!target) throw notFound('This invitation is no longer valid');
    const inviter = target.kind === 'email' ? target.invite.invitedById : target.team.ownerId;
    const refs = await loadUserRefs(db, [inviter]);
    const preview: InvitePreviewDTO = {
      workspace: {
        id: target.team.id,
        name: target.team.name,
        color: target.team.color,
        memberCount: await memberCount(db, target.team.id),
      },
      role: target.role,
      invitedBy: inviter ? (refs.get(inviter) ?? null) : null,
      email: target.kind === 'email' ? target.invite.email : null,
      member: !!(req.user && (await membershipRole(db, target.team.id, req.user.id))),
    };
    return { invite: preview };
  });

  app.post('/invites/:token/accept', async (req) => {
    if (!req.user) throw unauthorized();
    const user = req.user;
    const { token } = parse(tokenParams, req.params);
    const target = await resolveInvite(db, token);
    if (!target) throw notFound('This invitation is no longer valid');
    if (target.kind === 'email') {
      if (target.invite.email.toLowerCase() !== user.email.toLowerCase())
        throw new HttpError(
          403,
          'wrong_account',
          `This invitation is for ${target.invite.email}. Sign in with that email to accept it.`,
        );
      await db
        .update(workspaceInvites)
        .set({ acceptedAt: new Date(), acceptedById: user.id })
        .where(eq(workspaceInvites.id, target.invite.id));
    }
    await addMember(db, target.team.id, user.id, target.role);
    const role = (await membershipRole(db, target.team.id, user.id))!;
    return { workspace: workspaceDTO(target.team, role, await memberCount(db, target.team.id)) };
  });

  /** Pending email invitations addressed to the caller, for the inbox. */
  app.get('/invites', async (req) => {
    const user = requireUser(req);
    const rows = await db
      .select({ inv: workspaceInvites, w: workspaces })
      .from(workspaceInvites)
      .innerJoin(workspaces, eq(workspaces.id, workspaceInvites.workspaceId))
      .where(
        and(
          sql`lower(${workspaceInvites.email}) = ${user.email.toLowerCase()}`,
          sql`${workspaceInvites.acceptedAt} is null and ${workspaceInvites.revokedAt} is null and ${workspaceInvites.expiresAt} > now()`,
        ),
      );
    const dtos = await inviteDTOs(
      db,
      rows.map((r) => r.inv),
    );
    return {
      invites: rows.map((r, i) => ({
        ...dtos[i]!,
        workspace: { id: r.w.id, name: r.w.name, color: r.w.color },
      })),
    };
  });

  /** Accepts (or declines) an email invitation addressed to the caller, from the inbox. */
  app.post('/invites/id/:id/:action', async (req) => {
    const user = requireUser(req);
    const { id, action } = parse(
      z.object({ id: z.uuid(), action: z.enum(['accept', 'decline']) }),
      req.params,
    );
    const [inv] = await db.select().from(workspaceInvites).where(eq(workspaceInvites.id, id));
    if (
      !inv ||
      inv.acceptedAt ||
      inv.revokedAt ||
      inv.expiresAt.getTime() < Date.now() ||
      inv.email.toLowerCase() !== user.email.toLowerCase()
    )
      throw notFound('This invitation is no longer valid');
    if (action === 'decline') {
      await db
        .update(workspaceInvites)
        .set({ revokedAt: new Date() })
        .where(eq(workspaceInvites.id, id));
      return { ok: true };
    }
    await db
      .update(workspaceInvites)
      .set({ acceptedAt: new Date(), acceptedById: user.id })
      .where(eq(workspaceInvites.id, id));
    await addMember(db, inv.workspaceId, user.id, inv.role);
    return { ok: true, workspaceId: inv.workspaceId };
  });

  /**
   * Who may move something to another workspace: its owner, who must be able to add items at the
   * destination. Taking content out of a team also needs the team's owner role.
   */
  const checkMove = async (
    userId: string,
    from: string,
    role: Parameters<typeof can.manage>[0],
    dest: { workspaceId: string; folderId: string | null },
  ) => {
    if (!can.manage(role)) throw forbidden('Only the owner can move this');
    const fromRole = await membershipRole(db, from, userId);
    const [src] = await db
      .select({ kind: workspaces.kind })
      .from(workspaces)
      .where(eq(workspaces.id, from));
    if (src?.kind === 'team' && dest.workspaceId !== from && fromRole !== 'owner')
      throw forbidden('Only team owners can move things out of the team');
    await requireCreateIn(db, dest.workspaceId, dest.folderId, userId);
  };

  app.post('/documents/:id/move', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const body = parse(moveBody, req.body);
    const folderId = body.folderId ?? null;
    const a = await docAccess(db, { userId: user.id, documentId: id });
    if (a.doc.parentDocumentId) throw badRequest('This belongs to another document');
    await checkMove(user.id, a.doc.workspaceId, a.role, { workspaceId: body.workspaceId, folderId });
    await moveToWorkspace(
      db,
      { type: 'document', id, from: a.doc.workspaceId },
      {
        workspaceId: body.workspaceId,
        folderId,
        sort: await nextSort(db, 'documents', body.workspaceId, folderId),
      },
    );
    await logActivity(db, {
      workspaceId: body.workspaceId,
      documentId: id,
      actorId: user.id,
      kind: 'moved',
    });
    return { ok: true };
  });

  app.post('/folders/:id/move', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const body = parse(moveBody, req.body);
    const folderId = body.folderId ?? null;
    const a = await folderAccess(db, { userId: user.id, folderId: id });
    if (folderId && (await folderChain(db, folderId)).some((f) => f.id === id))
      throw badRequest('Cannot move a folder into itself');
    await checkMove(user.id, a.folder.workspaceId, a.role, {
      workspaceId: body.workspaceId,
      folderId,
    });
    await moveToWorkspace(
      db,
      { type: 'folder', id, from: a.folder.workspaceId },
      {
        workspaceId: body.workspaceId,
        folderId,
        sort: await nextSort(db, 'folders', body.workspaceId, folderId),
      },
    );
    return { ok: true };
  });
}
