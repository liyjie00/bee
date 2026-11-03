import type { FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  documentStars,
  documentViews,
  documents,
  users,
  workspaceMembers,
  workspaces,
} from '@bee/db';
import {
  INVITE_ROLES,
  TEAM_COLORS,
  WORKSPACE_ROLES,
  workspaceRoleAtLeast,
  type WorkspaceMemberDTO,
} from '@bee/shared';
import { docAccess, requireMember, workspaceView } from '../lib/access.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { documentDTOs, folderDTO, userRef, workspaceDTO } from '../lib/dto.js';
import { snippet } from '../lib/content.js';
import {
  inviteByEmail,
  memberCount,
  removeMember,
  requireAnotherOwner,
  requireTeam,
} from '../lib/teams.js';
import { idParams, parse } from '../lib/validate.js';
import { createWorkspace, requireUser, userWorkspaces } from './auth.js';

const email = z.email().transform((s) => s.trim().toLowerCase());
const createBody = z.object({
  name: z.string().trim().min(1).max(100),
  color: z.enum(TEAM_COLORS).optional(),
  /** invited as editors */
  emails: z.array(email).max(50).optional(),
});
const patchBody = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  color: z.enum(TEAM_COLORS).optional(),
});
const memberParams = z.object({ id: z.uuid(), userId: z.uuid() });

export async function workspaceRoutes(app: FastifyInstance) {
  const { db, config } = app;

  app.get('/workspaces', async (req) => ({
    workspaces: await userWorkspaces(db, requireUser(req).id),
  }));

  /** Creates a team; the personal workspace is made at sign-up. */
  app.post('/workspaces', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(createBody, req.body);
    const w = await createWorkspace(db, body.name, user.id, { color: body.color ?? TEAM_COLORS[0] });
    const invited = await inviteByEmail(db, {
      team: w,
      emails: (body.emails ?? []).filter((e) => e !== user.email.toLowerCase()),
      role: 'editor',
      inviter: user,
      publicUrl: config.publicUrl,
    });
    return reply.status(201).send({
      workspace: workspaceDTO(w, 'owner', 1),
      invites: invited.map((i) => ({ email: i.invite.email, url: i.url, emailed: i.emailed })),
    });
  });

  app.get('/workspaces/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const role = await requireMember(db, id, user.id);
    const [w] = await db.select().from(workspaces).where(eq(workspaces.id, id));
    return { workspace: workspaceDTO(w!, role, await memberCount(db, id)) };
  });

  app.patch('/workspaces/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const role = await requireMember(db, id, user.id);
    if (!workspaceRoleAtLeast(role, 'owner'))
      throw forbidden('Only owners can change the workspace');
    const body = parse(patchBody, req.body);
    const [w] = await db.update(workspaces).set(body).where(eq(workspaces.id, id)).returning();
    return { workspace: workspaceDTO(w!, role, await memberCount(db, id)) };
  });

  /** Deletes a team and everything in it. The name must be typed to confirm. */
  app.delete('/workspaces/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const { confirm } = parse(z.object({ confirm: z.string() }), req.query);
    const role = await requireMember(db, id, user.id);
    const w = await requireTeam(db, id);
    if (role !== 'owner') throw forbidden('Only owners can delete the team');
    if (confirm.trim() !== w.name.trim()) throw badRequest('Type the team name to confirm');
    await db.delete(workspaces).where(eq(workspaces.id, id));
    return { ok: true };
  });

  app.get('/workspaces/:id/members', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    await requireMember(db, id, user.id);
    const rows = await db
      .select({ u: users, role: workspaceMembers.role, joinedAt: workspaceMembers.createdAt })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, id))
      .orderBy(workspaceMembers.createdAt);
    const members: WorkspaceMemberDTO[] = rows.map((r) => ({
      user: { ...userRef(r.u), email: r.u.email },
      role: r.role,
      joinedAt: r.joinedAt.toISOString(),
    }));
    return { members };
  });

  /** Adds someone who already has an account straight away (owners only; no invitation). */
  app.post('/workspaces/:id/members', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const myRole = await requireMember(db, id, user.id);
    if (myRole !== 'owner') throw forbidden('Only owners can add members');
    const body = parse(z.object({ email, role: z.enum(WORKSPACE_ROLES) }), req.body);
    const [target] = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${body.email}`)
      .limit(1);
    if (!target) throw notFound('No user with that email. Invite them instead.');
    const inserted = await db
      .insert(workspaceMembers)
      .values({ workspaceId: id, userId: target.id, role: body.role })
      .onConflictDoNothing()
      .returning();
    if (!inserted.length) throw conflict('Already a member');
    return reply.status(201).send({
      member: {
        user: { ...userRef(target), email: target.email },
        role: body.role,
        joinedAt: inserted[0]!.createdAt.toISOString(),
      },
    });
  });

  /** Invites people by email. Editors may invite editors and viewers. */
  app.post('/workspaces/:id/invites', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const body = parse(
      z.object({ emails: z.array(email).min(1).max(50), role: z.enum(INVITE_ROLES) }),
      req.body,
    );
    const role = await requireMember(db, id, user.id);
    const team = await requireTeam(db, id);
    if (!workspaceRoleAtLeast(role, 'editor')) throw forbidden('Viewers cannot invite people');
    const invited = await inviteByEmail(db, {
      team,
      emails: body.emails,
      role: body.role,
      inviter: user,
      publicUrl: config.publicUrl,
    });
    return reply.status(201).send({
      invites: invited.map((i) => ({ email: i.invite.email, url: i.url, emailed: i.emailed })),
    });
  });

  app.patch('/workspaces/:id/members/:userId', async (req) => {
    const user = requireUser(req);
    const { id, userId } = parse(memberParams, req.params);
    const myRole = await requireMember(db, id, user.id);
    await requireTeam(db, id);
    if (myRole !== 'owner') throw forbidden('Only owners can change roles');
    const { role } = parse(z.object({ role: z.enum(WORKSPACE_ROLES) }), req.body);
    const targetRole = await requireMember(db, id, userId);
    if (targetRole === 'owner' && role !== 'owner') await requireAnotherOwner(db, id, userId);
    await db
      .update(workspaceMembers)
      .set({ role })
      .where(and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, userId)));
    return { ok: true };
  });

  /** Removes a member (owners), or leaves the team (anyone). */
  app.delete('/workspaces/:id/members/:userId', async (req) => {
    const user = requireUser(req);
    const { id, userId } = parse(memberParams, req.params);
    const myRole = await requireMember(db, id, user.id);
    await requireTeam(db, id);
    const self = userId === user.id;
    if (!self && myRole !== 'owner') throw forbidden('Only owners can remove members');
    const targetRole = await requireMember(db, id, userId);
    if (targetRole === 'owner') await requireAnotherOwner(db, id, userId);
    await removeMember(db, id, userId, self ? undefined : user.id);
    return { ok: true };
  });

  app.get('/workspaces/:id/tree', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const view = await workspaceView(db, id, user.id);
    // Hide folders whose parent the caller cannot see, re-rooting them, so the tree is navigable.
    const folders = view.folders
      .map((f) =>
        folderDTO(
          f.parentId && !view.readableFolders.has(f.parentId) ? { ...f, parentId: null } : f,
          f.role,
        ),
      )
      .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name));
    const docs = view.documents.map((d) =>
      d.folderId && !view.readableFolders.has(d.folderId) ? { ...d, folderId: null } : d,
    );
    const dtos = await documentDTOs(db, docs);
    dtos.sort((a, b) => a.sort - b.sort || b.updatedAt.localeCompare(a.updatedAt));
    return { folders, documents: dtos };
  });

  app.get('/workspaces/:id/search', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const { q } = parse(z.object({ q: z.string().trim().min(1).max(200) }), req.query);
    const view = await workspaceView(db, id, user.id);
    const readable = new Map(view.documents.map((d) => [d.id, d]));
    if (!readable.size) return { results: [] };
    const pattern = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    const rows = await db
      .select({ id: documents.id, title: documents.title, text: documents.textCache })
      .from(documents)
      .where(
        and(
          inArray(documents.id, [...readable.keys()]),
          sql`(${documents.title} ilike ${pattern} or ${documents.textCache} ilike ${pattern})`,
        ),
      )
      .orderBy(sql`(${documents.title} ilike ${pattern}) desc`, desc(documents.updatedAt))
      .limit(50);
    const dtos = await documentDTOs(
      db,
      rows.map((r) => readable.get(r.id)!),
    );
    return { results: dtos.map((d, i) => ({ document: d, snippet: snippet(rows[i]!.text, q) })) };
  });

  app.get('/workspaces/:id/trash', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const view = await workspaceView(db, id, user.id, { deleted: true });
    const docs = view.documents.filter((d) => d.role === 'owner');
    return {
      documents: await documentDTOs(db, docs),
      folders: view.folders.filter((f) => f.role === 'owner').map((f) => folderDTO(f, f.role)),
    };
  });

  app.get('/workspaces/:id/recent', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const view = await workspaceView(db, id, user.id);
    const readable = new Map(view.documents.map((d) => [d.id, d]));
    const viewed = await db
      .select({ documentId: documentViews.documentId, viewedAt: documentViews.viewedAt })
      .from(documentViews)
      .where(eq(documentViews.userId, user.id))
      .orderBy(desc(documentViews.viewedAt))
      .limit(200);
    const order = new Map<string, number>();
    for (const v of viewed)
      if (readable.has(v.documentId)) order.set(v.documentId, v.viewedAt.getTime());
    // Fall back to recently updated docs the user owns or edited.
    for (const d of view.documents) {
      if (!order.has(d.id) && (d.ownerId === user.id || d.lastEditedById === user.id)) {
        order.set(d.id, d.updatedAt.getTime());
      }
    }
    const docs = [...order.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([docId]) => readable.get(docId)!);
    return { documents: await documentDTOs(db, docs) };
  });

  app.get('/workspaces/:id/starred', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const view = await workspaceView(db, id, user.id);
    const readable = new Map(view.documents.map((d) => [d.id, d]));
    const stars = await db
      .select({ documentId: documentStars.documentId })
      .from(documentStars)
      .where(eq(documentStars.userId, user.id))
      .orderBy(desc(documentStars.createdAt))
      .limit(200);
    const docs = stars.map((s) => readable.get(s.documentId)).filter((d) => !!d);
    return { documents: await documentDTOs(db, docs) };
  });

  // Starring needs read access; unstarring always works.
  app.put('/documents/:id/star', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    await docAccess(db, { userId: user.id, documentId: id });
    await db
      .insert(documentStars)
      .values({ userId: user.id, documentId: id })
      .onConflictDoNothing();
    return { ok: true };
  });
  app.delete('/documents/:id/star', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    await db
      .delete(documentStars)
      .where(and(eq(documentStars.userId, user.id), eq(documentStars.documentId, id)));
    return { ok: true };
  });

  app.get('/workspaces/:id/shared-with-me', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const view = await workspaceView(db, id, user.id);
    const docs = view.documents
      .filter((d) => d.role !== 'owner')
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .slice(0, 100);
    return { documents: await documentDTOs(db, docs) };
  });
}
