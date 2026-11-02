import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { documents, permissions, shareLinks, users, type Db } from '@bee/db';
import {
  can,
  GRANTABLE_ROLES,
  LINK_ROLES,
  type GrantDTO,
  type ResourceType,
  type SharingDTO,
} from '@bee/shared';
import {
  docAccess,
  docMeta,
  folderAccess,
  linkRoleFor,
  validShareLink,
  type FolderRow,
} from '../lib/access.js';
import { logActivity } from '../lib/activity.js';
import { randomToken } from '../lib/auth.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { documentDTO, documentDTOs, loadUserRefs, shareLinkDTO, userRef } from '../lib/dto.js';
import { idParams, parse } from '../lib/validate.js';
import { requireUser } from './auth.js';

type PermRow = typeof permissions.$inferSelect;

const grantBody = z
  .object({
    email: z
      .email()
      .transform((s) => s.trim().toLowerCase())
      .optional(),
    workspace: z.boolean().optional(),
    role: z.enum(GRANTABLE_ROLES),
  })
  .refine((b) => !!b.email !== !!b.workspace, 'Provide either email or workspace: true');
const linkBody = z.object({
  role: z.enum(LINK_ROLES),
  public: z.boolean().default(true),
  expiresAt: z.iso.datetime().nullable().optional(),
});
const linkPatch = z.object({
  role: z.enum(LINK_ROLES).optional(),
  public: z.boolean().optional(),
  expiresAt: z.iso.datetime().nullable().optional(),
});

async function grantDTOs(
  db: Db,
  own: PermRow[],
  inherited: { grant: PermRow; folder: FolderRow }[],
): Promise<GrantDTO[]> {
  const userIds = [...own, ...inherited.map((i) => i.grant)]
    .filter((g) => g.principalType === 'user')
    .map((g) => g.principalId);
  const rows = userIds.length
    ? await db.select().from(users).where(inArray(users.id, userIds))
    : [];
  const byId = new Map(rows.map((u) => [u.id, u]));
  const one = (g: PermRow, sourceFolderId: string | null): GrantDTO => {
    const u = g.principalType === 'user' ? byId.get(g.principalId) : undefined;
    return {
      id: g.id,
      principalType: g.principalType,
      user: u ? { ...userRef(u), email: u.email } : null,
      role: g.role,
      inherited: sourceFolderId !== null,
      sourceFolderId,
    };
  };
  return [...own.map((g) => one(g, null)), ...inherited.map((i) => one(i.grant, i.folder.id))];
}

async function sharingFor(
  db: Db,
  resource: { type: ResourceType; id: string },
  chain: FolderRow[],
  publicUrl: string,
): Promise<SharingDTO> {
  const ids = [resource.id, ...chain.map((f) => f.id)];
  const all = await db.select().from(permissions).where(inArray(permissions.resourceId, ids));
  const own = all.filter((g) => g.resourceId === resource.id);
  const inherited: { grant: PermRow; folder: FolderRow }[] = [];
  const seen = new Set(own.map((g) => `${g.principalType}:${g.principalId}`));
  for (const f of chain) {
    if (f.id === resource.id) continue;
    for (const g of all.filter((x) => x.resourceId === f.id)) {
      const k = `${g.principalType}:${g.principalId}`;
      if (seen.has(k)) continue; // overridden by a nearer grant
      seen.add(k);
      inherited.push({ grant: g, folder: f });
    }
  }
  const links =
    resource.type === 'document'
      ? await db
          .select()
          .from(shareLinks)
          .where(and(eq(shareLinks.documentId, resource.id), isNull(shareLinks.revokedAt)))
          .orderBy(desc(shareLinks.createdAt))
      : [];
  return {
    grants: await grantDTOs(db, own, inherited),
    links: links.map((l) => shareLinkDTO(l, publicUrl)),
  };
}

export async function sharingRoutes(app: FastifyInstance) {
  const { db, config } = app;

  /** Resolves a resource and checks the caller may change its sharing (editor or above). */
  const manageable = async (type: ResourceType, id: string, userId: string) => {
    if (type === 'document') {
      const a = await docAccess(db, { userId, documentId: id });
      if (!can.edit(a.role)) throw forbidden('You cannot change sharing for this document');
      return { workspaceId: a.doc.workspaceId, chain: a.chain, role: a.role };
    }
    const a = await folderAccess(db, { userId, folderId: id });
    if (!can.edit(a.role)) throw forbidden('You cannot change sharing for this folder');
    return { workspaceId: a.folder.workspaceId, chain: a.chain, role: a.role! };
  };

  app.get('/documents/:id/sharing', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const a = await docAccess(db, { userId: user.id, documentId: id });
    const s = await sharingFor(db, { type: 'document', id }, a.chain, config.publicUrl);
    // Link tokens are only shown to people who can manage sharing.
    return can.edit(a.role) ? s : { ...s, links: [] };
  });

  app.get('/folders/:id/sharing', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const a = await folderAccess(db, { userId: user.id, folderId: id });
    return sharingFor(db, { type: 'folder', id }, a.chain, config.publicUrl);
  });

  const createGrant = (type: ResourceType) => async (req: FastifyRequest, reply: FastifyReply) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const body = parse(grantBody, req.body);
    const r = await manageable(type, id, user.id);
    let principalId = r.workspaceId;
    let target: typeof users.$inferSelect | undefined;
    if (body.email) {
      [target] = await db
        .select()
        .from(users)
        .where(sql`lower(${users.email}) = ${body.email}`)
        .limit(1);
      if (!target) throw notFound('No user with that email. Ask them to sign up first.');
      principalId = target.id;
    }
    const principalType = body.email ? 'user' : 'workspace';
    const [g] = await db
      .insert(permissions)
      .values({
        workspaceId: r.workspaceId,
        resourceType: type,
        resourceId: id,
        principalType,
        principalId,
        role: body.role,
        createdById: user.id,
      })
      .onConflictDoUpdate({
        target: [
          permissions.resourceType,
          permissions.resourceId,
          permissions.principalType,
          permissions.principalId,
        ],
        set: { role: body.role },
      })
      .returning();
    if (type === 'document') {
      await logActivity(db, {
        workspaceId: r.workspaceId,
        documentId: id,
        actorId: user.id,
        kind: 'shared',
        detail: `${target ? target.name : 'workspace'}: ${body.role}`,
      });
    }
    const [dto] = await grantDTOs(db, [g!], []);
    return reply.status(201).send({ grant: dto });
  };
  app.post('/documents/:id/grants', createGrant('document'));
  app.post('/folders/:id/grants', createGrant('folder'));

  const loadGrant = async (id: string, userId: string) => {
    const [g] = await db.select().from(permissions).where(eq(permissions.id, id));
    if (!g) throw notFound('Grant not found');
    await manageable(g.resourceType, g.resourceId, userId);
    return g;
  };

  app.patch('/grants/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const { role } = parse(z.object({ role: z.enum(GRANTABLE_ROLES) }), req.body);
    await loadGrant(id, user.id);
    const [g] = await db
      .update(permissions)
      .set({ role })
      .where(eq(permissions.id, id))
      .returning();
    const [dto] = await grantDTOs(db, [g!], []);
    return { grant: dto };
  });

  app.delete('/grants/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    await loadGrant(id, user.id);
    await db.delete(permissions).where(eq(permissions.id, id));
    return { ok: true };
  });

  app.post('/documents/:id/links', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const body = parse(linkBody, req.body);
    const r = await manageable('document', id, user.id);
    const [l] = await db
      .insert(shareLinks)
      .values({
        documentId: id,
        token: randomToken(18),
        role: body.role,
        public: body.public,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
        createdById: user.id,
      })
      .returning();
    await logActivity(db, {
      workspaceId: r.workspaceId,
      documentId: id,
      actorId: user.id,
      kind: 'shared',
      detail: `link: ${body.role}${body.public ? ' (public)' : ''}`,
    });
    return reply.status(201).send({ link: shareLinkDTO(l!, config.publicUrl) });
  });

  const loadLink = async (id: string, userId: string) => {
    const [l] = await db.select().from(shareLinks).where(eq(shareLinks.id, id));
    if (!l || l.revokedAt) throw notFound('Link not found');
    await manageable('document', l.documentId, userId);
    return l;
  };

  app.patch('/links/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const body = parse(linkPatch, req.body);
    await loadLink(id, user.id);
    const [l] = await db
      .update(shareLinks)
      .set({
        role: body.role,
        public: body.public,
        expiresAt:
          body.expiresAt === undefined
            ? undefined
            : body.expiresAt
              ? new Date(body.expiresAt)
              : null,
      })
      .where(eq(shareLinks.id, id))
      .returning();
    return { link: shareLinkDTO(l!, config.publicUrl) };
  });

  app.delete('/links/:id', async (req) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    await loadLink(id, user.id);
    await db.update(shareLinks).set({ revokedAt: new Date() }).where(eq(shareLinks.id, id));
    return { ok: true };
  });

  /** Landing for /s/:token. Anonymous visitors may open public links. */
  app.get('/share/:token', async (req) => {
    const { token } = parse(z.object({ token: z.string().min(8).max(100) }), req.params);
    const link = await validShareLink(db, token);
    if (!link) throw notFound('This link is invalid or has expired');
    const userId = req.user?.id ?? null;
    if (!linkRoleFor(link, userId)) throw badRequest('Sign in to open this link', 'login_required');
    const a = await docAccess(db, { userId, documentId: link.documentId, shareToken: token });
    const refs = await loadUserRefs(db, [a.doc.ownerId, a.doc.lastEditedById]);
    return { document: documentDTO(a.doc, a.role, refs), role: a.role };
  });

  /** Documents shared directly with the caller, across workspaces (incl. ones they are not a member of). */
  app.get('/shared-with-me', async (req) => {
    const user = requireUser(req);
    const grants = await db
      .select({ resourceId: permissions.resourceId, role: permissions.role })
      .from(permissions)
      .where(
        and(
          eq(permissions.principalType, 'user'),
          eq(permissions.principalId, user.id),
          eq(permissions.resourceType, 'document'),
        ),
      );
    if (!grants.length) return { documents: [] };
    const docs = await db
      .select(docMeta)
      .from(documents)
      .where(
        and(
          inArray(
            documents.id,
            grants.map((g) => g.resourceId),
          ),
          isNull(documents.deletedAt),
        ),
      )
      .orderBy(desc(documents.updatedAt));
    const withRole = [];
    for (const d of docs) {
      try {
        const a = await docAccess(db, { userId: user.id, documentId: d.id });
        withRole.push({ ...d, role: a.role });
      } catch {
        /* no longer readable */
      }
    }
    return { documents: await documentDTOs(db, withRole) };
  });
}
