import type { FastifyInstance } from 'fastify';
import { and, eq, isNull, max, sql } from 'drizzle-orm';
import { z } from 'zod';
import { folders, type Db } from '@bee/db';
import { can, TEAM_BASELINE } from '@bee/shared';
import { folderAccess, folderChain, isTeam, requireMember } from '../lib/access.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { folderDTO } from '../lib/dto.js';
import { idParams, parse } from '../lib/validate.js';
import { requireUser } from './auth.js';

const createBody = z.object({
  workspaceId: z.uuid(),
  parentId: z.uuid().nullable().optional(),
  name: z.string().trim().min(1).max(200),
});
const updateBody = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  parentId: z.uuid().nullable().optional(),
  sort: z.number().finite().optional(),
  /** team folders: hide from members who are not granted access */
  restricted: z.boolean().optional(),
});

/** Checks the caller may create things inside `folderId` (or at the workspace root). */
export async function requireCreateIn(
  db: Db,
  workspaceId: string,
  folderId: string | null,
  userId: string,
) {
  const role = await requireMember(db, workspaceId, userId);
  if (!folderId) {
    // A team's top level is open to everyone who can edit team content.
    if (role !== 'owner' && (await isTeam(db, workspaceId)) && !can.edit(TEAM_BASELINE[role]))
      throw forbidden('Viewers cannot add items to the team');
    return;
  }
  const a = await folderAccess(db, { userId, folderId });
  if (a.folder.workspaceId !== workspaceId) throw badRequest('Folder is in another workspace');
  if (!can.edit(a.role)) throw forbidden('You cannot add items to this folder');
}

async function nextSort(db: Db, workspaceId: string, parentId: string | null) {
  const [r] = await db
    .select({ m: max(folders.sort) })
    .from(folders)
    .where(
      and(
        eq(folders.workspaceId, workspaceId),
        parentId ? eq(folders.parentId, parentId) : isNull(folders.parentId),
      ),
    );
  return (r?.m ?? 0) + 1;
}

export async function folderRoutes(app: FastifyInstance) {
  const { db } = app;

  app.post('/folders', async (req, reply) => {
    const user = requireUser(req);
    const body = parse(createBody, req.body);
    const parentId = body.parentId ?? null;
    await requireCreateIn(db, body.workspaceId, parentId, user.id);
    const [f] = await db
      .insert(folders)
      .values({
        workspaceId: body.workspaceId,
        parentId,
        name: body.name,
        ownerId: user.id,
        sort: await nextSort(db, body.workspaceId, parentId),
      })
      .returning();
    const a = await folderAccess(db, { userId: user.id, folderId: f!.id });
    return reply.status(201).send({ folder: folderDTO(f!, a.role!) });
  });

  app.get('/folders/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const a = await folderAccess(db, { userId: user.id, folderId: id });
    return { folder: folderDTO(a.folder, a.role!) };
  });

  app.patch('/folders/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const body = parse(updateBody, req.body);
    const a = await folderAccess(db, { userId: user.id, folderId: id });
    if (!can.edit(a.role)) throw forbidden('You cannot edit this folder');
    const patch: Partial<typeof folders.$inferInsert> = { updatedAt: new Date() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.sort !== undefined) patch.sort = body.sort;
    if (body.restricted !== undefined && body.restricted !== a.folder.restricted) {
      if (!a.team) throw badRequest('Only team folders can be restricted');
      // Restricting can lock the team's owners out too, so it is for the folder's owners.
      if (body.restricted && !a.chain.some((f) => f.ownerId === user.id))
        throw forbidden('Only the folder’s owner can restrict it');
      if (!can.manage(a.role)) throw forbidden('Only the owner can change who sees this folder');
      patch.restricted = body.restricted;
    }
    if (body.parentId !== undefined && body.parentId !== a.folder.parentId) {
      const dest = body.parentId;
      if (dest) {
        const destChain = await folderChain(db, dest);
        if (destChain.some((f) => f.id === id))
          throw badRequest('Cannot move a folder into itself');
      }
      // Moving out of a parent changes inherited access: require ownership of the folder.
      if (!can.manage(a.role)) throw forbidden('Only the owner can move this folder');
      await requireCreateIn(db, a.folder.workspaceId, dest, user.id);
      patch.parentId = dest;
      if (body.sort === undefined) patch.sort = await nextSort(db, a.folder.workspaceId, dest);
    }
    const [f] = await db.update(folders).set(patch).where(eq(folders.id, id)).returning();
    const after = await folderAccess(db, { userId: user.id, folderId: id });
    return { folder: folderDTO(f!, after.role!) };
  });

  /** Soft delete: the folder and everything below it disappear from the tree. */
  app.delete('/folders/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const { permanent } = parse(z.object({ permanent: z.coerce.boolean().optional() }), req.query);
    const a = await folderAccess(db, { userId: user.id, folderId: id, includeDeleted: true });
    if (!can.manage(a.role)) throw forbidden('Only the owner can delete this folder');
    if (permanent) {
      if (!a.folder.deletedAt) throw badRequest('Move the folder to the trash first');
      // Documents inside are moved to the trash at the workspace root rather than destroyed.
      await db.execute(sql`
        with recursive sub as (
          select id from folders where id = ${id}
          union all select f.id from folders f join sub on f.parent_id = sub.id
        )
        update documents set folder_id = null, deleted_at = coalesce(deleted_at, now())
        where folder_id in (select id from sub)`);
      await db.delete(folders).where(eq(folders.id, id));
    } else {
      await db.update(folders).set({ deletedAt: new Date() }).where(eq(folders.id, id));
    }
    return { ok: true };
  });

  app.post('/folders/:id/restore', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const a = await folderAccess(db, { userId: user.id, folderId: id, includeDeleted: true });
    if (!can.manage(a.role)) throw forbidden();
    const [f] = await db
      .update(folders)
      .set({ deletedAt: null })
      .where(eq(folders.id, id))
      .returning();
    return { folder: folderDTO(f!, a.role!) };
  });
}
