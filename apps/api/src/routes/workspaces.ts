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
import { WORKSPACE_ROLES, workspaceRoleAtLeast, type WorkspaceMemberDTO } from '@bee/shared';
import { docAccess, requireMember, workspaceView } from '../lib/access.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { documentDTOs, folderDTO, userRef, workspaceDTO } from '../lib/dto.js';
import { snippet } from '../lib/content.js';
import { idParams, parse } from '../lib/validate.js';
import { createWorkspace, requireUser, userWorkspaces } from './auth.js';

const nameBody = z.object({ name: z.string().trim().min(1).max(100) });
const addMemberBody = z.object({
  email: z.email().transform((s) => s.trim().toLowerCase()),
  role: z.enum(WORKSPACE_ROLES),
});
const memberParams = z.object({ id: z.uuid(), userId: z.uuid() });

export async function workspaceRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get('/workspaces', async (req) => ({
    workspaces: await userWorkspaces(db, requireUser(req).id),
  }));

  app.post('/workspaces', async (req, reply) => {
    const user = requireUser(req);
    const { name } = parse(nameBody, req.body);
    const w = await createWorkspace(db, name, user.id);
    return reply.status(201).send({ workspace: workspaceDTO(w, 'owner') });
  });

  app.get('/workspaces/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const role = await requireMember(db, id, user.id);
    const [w] = await db.select().from(workspaces).where(eq(workspaces.id, id));
    return { workspace: workspaceDTO(w!, role) };
  });

  app.patch('/workspaces/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const role = await requireMember(db, id, user.id);
    if (!workspaceRoleAtLeast(role, 'admin'))
      throw forbidden('Only admins can rename the workspace');
    const { name } = parse(nameBody, req.body);
    const [w] = await db.update(workspaces).set({ name }).where(eq(workspaces.id, id)).returning();
    return { workspace: workspaceDTO(w!, role) };
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

  app.post('/workspaces/:id/members', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const myRole = await requireMember(db, id, user.id);
    if (!workspaceRoleAtLeast(myRole, 'admin')) throw forbidden('Only admins can add members');
    const body = parse(addMemberBody, req.body);
    if (body.role === 'owner') throw badRequest('There can only be one owner');
    const [target] = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${body.email}`)
      .limit(1);
    if (!target) throw notFound('No user with that email. Ask them to sign up first.');
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

  app.patch('/workspaces/:id/members/:userId', async (req) => {
    const user = requireUser(req);
    const { id, userId } = parse(memberParams, req.params);
    const myRole = await requireMember(db, id, user.id);
    if (!workspaceRoleAtLeast(myRole, 'admin')) throw forbidden();
    const { role } = parse(z.object({ role: z.enum(['member', 'admin']) }), req.body);
    const targetRole = await requireMember(db, id, userId);
    if (targetRole === 'owner') throw badRequest('Cannot change the owner role');
    await db
      .update(workspaceMembers)
      .set({ role })
      .where(and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, userId)));
    return { ok: true };
  });

  app.delete('/workspaces/:id/members/:userId', async (req) => {
    const user = requireUser(req);
    const { id, userId } = parse(memberParams, req.params);
    const myRole = await requireMember(db, id, user.id);
    if (userId !== user.id && !workspaceRoleAtLeast(myRole, 'admin')) throw forbidden();
    const targetRole = await requireMember(db, id, userId);
    if (targetRole === 'owner') throw badRequest('The owner cannot leave the workspace');
    await db
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, id), eq(workspaceMembers.userId, userId)));
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
