import { inArray } from 'drizzle-orm';
import { users, workspaces, type Db } from '@bee/db';
import type {
  DocumentDTO,
  FolderDTO,
  Role,
  ShareLinkDTO,
  UserDTO,
  UserRef,
  WorkspaceDTO,
  WorkspaceRole,
} from '@bee/shared';
import { shareLinkPath } from '@bee/shared';
import type { UserRow } from './auth.js';
import type { DocMeta, FolderRow, ShareLinkRow } from './access.js';

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

export function userDTO(u: UserRow): UserDTO {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    avatarUrl: u.avatarUrl,
    color: u.color,
    createdAt: u.createdAt.toISOString(),
    prefs: u.prefs ?? {},
    setupRequired: u.setupRequired,
  };
}

export function userRef(u: Pick<UserRow, 'id' | 'name' | 'avatarUrl' | 'color'>): UserRef {
  return { id: u.id, name: u.name, avatarUrl: u.avatarUrl, color: u.color };
}

const UNKNOWN: UserRef = { id: '', name: 'Unknown', avatarUrl: null, color: '#8B8D98' };

/** Batch-loads user refs. */
export async function loadUserRefs(
  db: Db,
  ids: (string | null | undefined)[],
): Promise<Map<string, UserRef>> {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  const map = new Map<string, UserRef>();
  if (!uniq.length) return map;
  const rows = await db
    .select({
      id: users.id,
      name: users.name,
      avatarUrl: users.avatarUrl,
      color: users.color,
      email: users.email,
    })
    .from(users)
    .where(inArray(users.id, uniq));
  for (const r of rows) map.set(r.id, userRef(r));
  return map;
}

export const refOr = (map: Map<string, UserRef>, id: string | null | undefined): UserRef =>
  (id && map.get(id)) || { ...UNKNOWN, id: id ?? '' };

export function workspaceDTO(w: typeof workspaces.$inferSelect, role: WorkspaceRole): WorkspaceDTO {
  return { id: w.id, name: w.name, slug: w.slug, role, createdAt: w.createdAt.toISOString() };
}

export function folderDTO(f: FolderRow, role: Role): FolderDTO {
  return {
    id: f.id,
    workspaceId: f.workspaceId,
    parentId: f.parentId,
    name: f.name,
    sort: f.sort,
    ownerId: f.ownerId,
    role,
    createdAt: f.createdAt.toISOString(),
    updatedAt: f.updatedAt.toISOString(),
  };
}

export function documentDTO(d: DocMeta, role: Role, refs: Map<string, UserRef>): DocumentDTO {
  return {
    id: d.id,
    workspaceId: d.workspaceId,
    folderId: d.folderId,
    parentDocumentId: d.parentDocumentId,
    type: d.type,
    title: d.title,
    icon: d.icon,
    sort: d.sort,
    owner: refOr(refs, d.ownerId),
    role,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    lastEditedBy: d.lastEditedById ? refOr(refs, d.lastEditedById) : null,
    deletedAt: iso(d.deletedAt),
  };
}

export async function documentDTOs(
  db: Db,
  docs: (DocMeta & { role: Role })[],
): Promise<DocumentDTO[]> {
  const refs = await loadUserRefs(
    db,
    docs.flatMap((d) => [d.ownerId, d.lastEditedById]),
  );
  return docs.map((d) => documentDTO(d, d.role, refs));
}

export function shareLinkDTO(l: ShareLinkRow, publicUrl: string): ShareLinkDTO {
  return {
    id: l.id,
    documentId: l.documentId,
    token: l.token,
    role: l.role,
    public: l.public,
    guestComments: l.guestComments,
    expiresAt: iso(l.expiresAt),
    createdAt: l.createdAt.toISOString(),
    url: publicUrl + shareLinkPath(l.token),
  };
}
