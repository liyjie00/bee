/**
 * Bee permission model.
 *
 * Roles on a document (or folder), strongest first: owner > editor > commenter > viewer.
 * Grants are attached to folders or documents and name a principal: a single user,
 * or every member of the workspace. Folder grants are inherited by everything below
 * them; for a given principal the nearest grant wins (a document grant overrides a
 * folder grant, a child folder overrides its parent), so access can also be narrowed.
 * The user's effective role is the strongest role across all principals that match them,
 * combined with the share-link role if they arrived through a link.
 */

export const ROLES = ['viewer', 'commenter', 'editor', 'owner'] as const;
export type Role = (typeof ROLES)[number];

/** Roles that can be granted to others (owner is only via ownership). */
export const GRANTABLE_ROLES = ['viewer', 'commenter', 'editor'] as const;
export type GrantableRole = (typeof GRANTABLE_ROLES)[number];

/** Roles a share link can carry. */
export const LINK_ROLES = ['viewer', 'commenter', 'editor'] as const;
export type LinkRole = (typeof LINK_ROLES)[number];

export const WORKSPACE_ROLES = ['member', 'admin', 'owner'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export type PrincipalType = 'user' | 'workspace';
export type ResourceType = 'folder' | 'document';

export function roleRank(role: Role | null | undefined): number {
  return role ? ROLES.indexOf(role) + 1 : 0;
}

export function roleAtLeast(role: Role | null | undefined, min: Role): boolean {
  return roleRank(role) >= roleRank(min);
}

export function maxRole(...roles: (Role | null | undefined)[]): Role | null {
  let best: Role | null = null;
  for (const r of roles) if (roleRank(r) > roleRank(best)) best = r ?? null;
  return best;
}

export function workspaceRoleAtLeast(
  role: WorkspaceRole | null | undefined,
  min: WorkspaceRole,
): boolean {
  if (!role) return false;
  return WORKSPACE_ROLES.indexOf(role) >= WORKSPACE_ROLES.indexOf(min);
}

export interface Grant {
  principalType: PrincipalType;
  /** user id, or workspace id for principalType 'workspace' */
  principalId: string;
  role: GrantableRole;
}

/** One node in the path from the resource up to the root folder. */
export interface ChainNode {
  type: ResourceType;
  id: string;
  ownerId: string;
  grants: Grant[];
}

export interface AccessInput {
  /** null for anonymous visitors */
  userId: string | null;
  workspaceId: string;
  /** the user's membership role in the resource's workspace, if any */
  workspaceRole: WorkspaceRole | null;
  /** resource first, then its parent folder, ... up to the root folder */
  chain: ChainNode[];
  /** role granted by a valid share link presented with the request */
  linkRole?: LinkRole | null;
}

/**
 * Effective role on the first node in `chain`, or null when there is no access.
 */
export function effectiveRole(input: AccessInput): Role | null {
  const { userId, workspaceId, workspaceRole, chain, linkRole } = input;
  let role: Role | null = linkRole ?? null;
  if (!userId) return role;

  // Ownership of the resource or any ancestor folder makes the user owner of the subtree.
  if (chain.some((n) => n.ownerId === userId)) return 'owner';

  const principals: { type: PrincipalType; id: string }[] = [{ type: 'user', id: userId }];
  if (workspaceRole) principals.push({ type: 'workspace', id: workspaceId });

  for (const p of principals) {
    for (const node of chain) {
      const g = node.grants.find((x) => x.principalType === p.type && x.principalId === p.id);
      if (g) {
        role = maxRole(role, g.role);
        break; // nearest grant for this principal wins
      }
    }
  }
  return role;
}

/** What each role is allowed to do. */
export const can = {
  read: (r: Role | null | undefined) => roleAtLeast(r, 'viewer'),
  comment: (r: Role | null | undefined) => roleAtLeast(r, 'commenter'),
  edit: (r: Role | null | undefined) => roleAtLeast(r, 'editor'),
  /** change sharing, rename/move/delete, restore versions */
  manage: (r: Role | null | undefined) => roleAtLeast(r, 'owner'),
};

/** Whether a Yjs connection with this role may write to the document. */
export function isReadOnly(role: Role | null | undefined): boolean {
  return !roleAtLeast(role, 'editor');
}
