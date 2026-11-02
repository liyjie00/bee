import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  documentEmbeds,
  documents,
  folders,
  permissions,
  shareLinks,
  workspaceMembers,
  type Db,
} from '@bee/db';
import {
  can,
  effectiveRole,
  maxRole,
  type ChainNode,
  type Grant,
  type LinkRole,
  type Role,
  type WorkspaceRole,
} from '@bee/shared';
import { forbidden, notFound, unauthorized } from './errors.js';

export type DocRow = typeof documents.$inferSelect;
export type FolderRow = typeof folders.$inferSelect;
export type ShareLinkRow = typeof shareLinks.$inferSelect;
type PermRow = typeof permissions.$inferSelect;

/** Document columns without the (large) content fields. */
export const docMeta = {
  id: documents.id,
  workspaceId: documents.workspaceId,
  folderId: documents.folderId,
  type: documents.type,
  title: documents.title,
  icon: documents.icon,
  sort: documents.sort,
  ownerId: documents.ownerId,
  parentDocumentId: documents.parentDocumentId,
  lastEditedById: documents.lastEditedById,
  createdAt: documents.createdAt,
  updatedAt: documents.updatedAt,
  contentUpdatedAt: documents.contentUpdatedAt,
  deletedAt: documents.deletedAt,
};
export type DocMeta = Omit<DocRow, 'ydocState' | 'markdownCache' | 'textCache' | 'blockIds'>;

export interface Viewer {
  userId: string | null;
}

export async function membershipRole(
  db: Db,
  workspaceId: string,
  userId: string | null,
): Promise<WorkspaceRole | null> {
  if (!userId) return null;
  const rows = await db
    .select({ role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  return rows[0]?.role ?? null;
}

export async function requireMember(db: Db, workspaceId: string, userId: string | null) {
  if (!userId) throw unauthorized();
  const role = await membershipRole(db, workspaceId, userId);
  if (!role) throw notFound('Workspace not found');
  return role;
}

/** The folder and its ancestors, nearest first. */
export async function folderChain(db: Db, folderId: string | null): Promise<FolderRow[]> {
  if (!folderId) return [];
  const res = await db.execute<{ id: string }>(sql`
    with recursive chain as (
      select id, parent_id, 0 as depth from folders where id = ${folderId}
      union all
      select f.id, f.parent_id, c.depth + 1 from folders f join chain c on f.id = c.parent_id
      where c.depth < 64
    )
    select id from chain order by depth`);
  const ids = res.rows.map((r) => r.id);
  if (!ids.length) return [];
  const rows = await db.select().from(folders).where(inArray(folders.id, ids));
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)!).filter(Boolean);
}

export async function grantsFor(db: Db, resourceIds: string[]): Promise<Map<string, PermRow[]>> {
  const map = new Map<string, PermRow[]>();
  if (!resourceIds.length) return map;
  const rows = await db
    .select()
    .from(permissions)
    .where(inArray(permissions.resourceId, resourceIds));
  for (const r of rows) {
    const list = map.get(r.resourceId) ?? [];
    list.push(r);
    map.set(r.resourceId, list);
  }
  return map;
}

const toGrant = (p: PermRow): Grant => ({
  principalType: p.principalType,
  principalId: p.principalId,
  role: p.role,
});

/** A share link that is not revoked or expired, optionally bound to a document. */
export async function validShareLink(
  db: Db,
  token: string | undefined | null,
  documentId?: string,
): Promise<ShareLinkRow | null> {
  if (!token) return null;
  const rows = await db.select().from(shareLinks).where(eq(shareLinks.token, token)).limit(1);
  const link = rows[0];
  if (!link || link.revokedAt) return null;
  if (link.expiresAt && link.expiresAt.getTime() < Date.now()) return null;
  if (documentId && link.documentId !== documentId) return null;
  return link;
}

/**
 * Role a share link gives. Anyone with the link may open it without signing in;
 * anonymous visitors never edit without an identity, so they are capped at commenter
 * (see guestsMayComment), else viewer.
 */
export function linkRoleFor(link: ShareLinkRow | null, userId: string | null): LinkRole | null {
  if (!link) return null;
  if (!userId) return guestsMayComment(link) ? 'commenter' : 'viewer';
  return link.role;
}

/**
 * Whether anonymous visitors may comment (with a nickname) through this link: an
 * "anyone with the link" link whose role allows comments, or a published (public)
 * link with guest comments turned on.
 */
export function guestsMayComment(link: ShareLinkRow | null): boolean {
  return !!link && can.comment(link.role) && (!link.public || link.guestComments);
}

/** Embed marker the host's Markdown keeps while it still contains the embed. */
export const embedMarker = (embeddedId: string) => `bee:whiteboard ${embeddedId}`;

async function viewableThroughHost(
  db: Db,
  embeddedId: string,
  opts: { userId: string | null; shareToken?: string | null; depth?: number },
): Promise<boolean> {
  const hosts = await db
    .select({ id: documents.id, markdown: documents.markdownCache })
    .from(documentEmbeds)
    .innerJoin(documents, eq(documents.id, documentEmbeds.documentId))
    .where(and(eq(documentEmbeds.embeddedId, embeddedId), isNull(documents.deletedAt)))
    .limit(20);
  for (const h of hosts) {
    if (!h.markdown?.includes(embedMarker(embeddedId))) continue;
    try {
      const host = await docAccess(db, {
        userId: opts.userId,
        documentId: h.id,
        shareToken: opts.shareToken,
        depth: (opts.depth ?? 0) + 1,
      });
      if (can.read(host.role)) return true;
    } catch {
      /* no access to this host */
    }
  }
  return false;
}

export interface DocAccess {
  doc: DocRow;
  role: Role;
  chain: FolderRow[];
  workspaceRole: WorkspaceRole | null;
}

/**
 * Loads a document and the caller's effective role. Throws 404 when the document
 * does not exist or the caller cannot read it (so existence is not leaked), 401
 * when an anonymous caller could not read it.
 */
export async function docAccess(
  db: Db,
  opts: {
    userId: string | null;
    documentId: string;
    shareToken?: string | null;
    includeDeleted?: boolean;
    /** internal: recursion guard for embedded documents */
    depth?: number;
    /** ignore access through documents that link this one in */
    direct?: boolean;
  },
): Promise<DocAccess> {
  const rows = await db.select().from(documents).where(eq(documents.id, opts.documentId)).limit(1);
  const doc = rows[0];
  if (!doc || (doc.deletedAt && !opts.includeDeleted)) throw notFound('Document not found');
  const [chain, workspaceRole, link] = await Promise.all([
    folderChain(db, doc.folderId),
    membershipRole(db, doc.workspaceId, opts.userId),
    validShareLink(db, opts.shareToken, doc.id),
  ]);
  const grants = await grantsFor(db, [doc.id, ...chain.map((f) => f.id)]);
  const nodes: ChainNode[] = [
    {
      type: 'document',
      id: doc.id,
      ownerId: doc.ownerId,
      grants: (grants.get(doc.id) ?? []).map(toGrant),
    },
    ...chain.map((f) => ({
      type: 'folder' as const,
      id: f.id,
      ownerId: f.ownerId,
      grants: (grants.get(f.id) ?? []).map(toGrant),
    })),
  ];
  let role = effectiveRole({
    userId: opts.userId,
    workspaceId: doc.workspaceId,
    workspaceRole,
    chain: nodes,
    linkRole: doc.deletedAt ? null : linkRoleFor(link, opts.userId),
  });
  // Embedded content (e.g. a whiteboard in a doc) also gets the parent document's access,
  // including access through the parent's share link.
  if (doc.parentDocumentId && (opts.depth ?? 0) < 8 && !doc.deletedAt) {
    try {
      const parent = await docAccess(db, {
        userId: opts.userId,
        documentId: doc.parentDocumentId,
        shareToken: opts.shareToken,
        depth: (opts.depth ?? 0) + 1,
      });
      role = maxRole(role, parent.role);
    } catch {
      /* no access through the parent */
    }
  }
  // A standalone document linked into another one (e.g. a whiteboard inserted into a doc) can be
  // viewed by readers of a host that still embeds it.
  if (
    !can.read(role) &&
    !opts.direct &&
    (opts.depth ?? 0) < 8 &&
    !doc.deletedAt &&
    !doc.parentDocumentId
  ) {
    if (await viewableThroughHost(db, doc.id, opts)) role = maxRole(role, 'viewer');
  }
  if (!can.read(role)) {
    if (!opts.userId) throw unauthorized();
    throw notFound('Document not found');
  }
  return { doc, role: role!, chain, workspaceRole };
}

export async function requireDocRole(
  db: Db,
  opts: Parameters<typeof docAccess>[1],
  check: (r: Role) => boolean,
  message?: string,
): Promise<DocAccess> {
  const a = await docAccess(db, opts);
  if (!check(a.role)) throw forbidden(message);
  return a;
}

export interface FolderAccess {
  folder: FolderRow;
  role: Role | null;
  chain: FolderRow[];
  workspaceRole: WorkspaceRole | null;
}

export async function folderAccess(
  db: Db,
  opts: { userId: string | null; folderId: string; includeDeleted?: boolean },
): Promise<FolderAccess> {
  const chain = await folderChain(db, opts.folderId);
  const folder = chain[0];
  if (!folder || (folder.deletedAt && !opts.includeDeleted)) throw notFound('Folder not found');
  const workspaceRole = await membershipRole(db, folder.workspaceId, opts.userId);
  const grants = await grantsFor(
    db,
    chain.map((f) => f.id),
  );
  const role = effectiveRole({
    userId: opts.userId,
    workspaceId: folder.workspaceId,
    workspaceRole,
    chain: chain.map((f) => ({
      type: 'folder' as const,
      id: f.id,
      ownerId: f.ownerId,
      grants: (grants.get(f.id) ?? []).map(toGrant),
    })),
  });
  if (!can.read(role)) throw notFound('Folder not found');
  return { folder, role, chain, workspaceRole };
}

export interface WorkspaceView {
  workspaceRole: WorkspaceRole;
  folders: (FolderRow & { role: Role })[];
  documents: (DocMeta & { role: Role })[];
  /** folder ids the caller can read */
  readableFolders: Set<string>;
}

/**
 * Everything in a workspace the caller can read, with roles. Loads the whole
 * workspace's folders, document metadata and grants once (fine for teams).
 */
export async function workspaceView(
  db: Db,
  workspaceId: string,
  userId: string,
  opts: { deleted?: boolean } = {},
): Promise<WorkspaceView> {
  const workspaceRole = await requireMember(db, workspaceId, userId);
  const [allFolders, allDocs, allGrants] = await Promise.all([
    db.select().from(folders).where(eq(folders.workspaceId, workspaceId)),
    db
      .select(docMeta)
      .from(documents)
      .where(
        and(
          eq(documents.workspaceId, workspaceId),
          opts.deleted ? sql`${documents.deletedAt} is not null` : isNull(documents.deletedAt),
        ),
      ),
    db.select().from(permissions).where(eq(permissions.workspaceId, workspaceId)),
  ]);
  const grants = new Map<string, Grant[]>();
  for (const g of allGrants) {
    const list = grants.get(g.resourceId) ?? [];
    list.push(toGrant(g));
    grants.set(g.resourceId, list);
  }
  const folderById = new Map(allFolders.map((f) => [f.id, f]));
  const chainCache = new Map<string, ChainNode[]>();
  const chainOf = (folderId: string | null): ChainNode[] => {
    if (!folderId) return [];
    const hit = chainCache.get(folderId);
    if (hit) return hit;
    const nodes: ChainNode[] = [];
    let cur = folderById.get(folderId);
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      nodes.push({
        type: 'folder',
        id: cur.id,
        ownerId: cur.ownerId,
        grants: grants.get(cur.id) ?? [],
      });
      cur = cur.parentId ? folderById.get(cur.parentId) : undefined;
    }
    chainCache.set(folderId, nodes);
    return nodes;
  };
  // A folder is hidden when it or any ancestor is in the trash.
  const inTrash = (folderId: string | null): boolean => {
    let cur = folderId ? folderById.get(folderId) : undefined;
    const seen = new Set<string>();
    while (cur && !seen.has(cur.id)) {
      if (cur.deletedAt) return true;
      seen.add(cur.id);
      cur = cur.parentId ? folderById.get(cur.parentId) : undefined;
    }
    return false;
  };

  const roleIn = (chain: ChainNode[]) =>
    effectiveRole({ userId, workspaceId, workspaceRole, chain });

  const visibleFolders: (FolderRow & { role: Role })[] = [];
  for (const f of allFolders) {
    if (!opts.deleted && inTrash(f.id)) continue;
    if (opts.deleted && !f.deletedAt) continue;
    const role = roleIn(chainOf(f.id));
    if (role) visibleFolders.push({ ...f, role });
  }
  const visibleDocs: (DocMeta & { role: Role })[] = [];
  for (const d of allDocs) {
    if (d.parentDocumentId) continue; // embedded content is not listed on its own
    if (!opts.deleted && inTrash(d.folderId)) continue;
    const role = roleIn([
      { type: 'document', id: d.id, ownerId: d.ownerId, grants: grants.get(d.id) ?? [] },
      ...chainOf(d.folderId),
    ]);
    if (role) visibleDocs.push({ ...d, role });
  }
  return {
    workspaceRole,
    folders: visibleFolders,
    documents: visibleDocs,
    readableFolders: new Set(visibleFolders.map((f) => f.id)),
  };
}
