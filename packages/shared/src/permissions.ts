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
 *
 * Team workspaces add a baseline from the membership role (owner → owner, editor → editor,
 * viewer → commenter) on everything in the team. A "workspace" grant on a folder or document
 * replaces that baseline for non-owners below it. A restricted folder hides its subtree from the
 * team: there neither the baseline nor "workspace" grants count, only grants to the person
 * (and ownership).
 */

export const ROLES = ['viewer', 'commenter', 'editor', 'owner'] as const;
export type Role = (typeof ROLES)[number];

/** Roles that can be granted to others (owner is only via ownership). */
export const GRANTABLE_ROLES = ['viewer', 'commenter', 'editor'] as const;
export type GrantableRole = (typeof GRANTABLE_ROLES)[number];

/** Roles a share link can carry. */
export const LINK_ROLES = ['viewer', 'commenter', 'editor'] as const;
export type LinkRole = (typeof LINK_ROLES)[number];

/** Membership roles, weakest first. In a personal workspace only the owner is a member. */
export const WORKSPACE_ROLES = ['viewer', 'editor', 'owner'] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const WORKSPACE_KINDS = ['personal', 'team'] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

/** Role a team member gets on team content before folder or document grants. */
export const TEAM_BASELINE: Record<WorkspaceRole, Role> = {
  owner: 'owner',
  editor: 'editor',
  viewer: 'commenter',
};

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
  /** folders only: hidden from the team except people granted access */
  restricted?: boolean;
}

export interface AccessInput {
  /** null for anonymous visitors */
  userId: string | null;
  workspaceId: string;
  /** the user's membership role in the resource's workspace, if any */
  workspaceRole: WorkspaceRole | null;
  /** true when the resource's workspace is a team (adds the membership baseline) */
  team?: boolean;
  /** resource first, then its parent folder, ... up to the root folder */
  chain: ChainNode[];
  /** role granted by a valid share link presented with the request */
  linkRole?: LinkRole | null;
}

/**
 * Effective role on the first node in `chain`, or null when there is no access.
 */
export function effectiveRole(input: AccessInput): Role | null {
  const { userId, workspaceId, workspaceRole, chain, linkRole, team } = input;
  let role: Role | null = linkRole ?? null;
  if (!userId) return role;

  // Ownership of the resource or any ancestor folder makes the user owner of the subtree
  // (in a team only while they are a member).
  if ((!team || workspaceRole) && chain.some((n) => n.ownerId === userId)) return 'owner';

  const nearest = (type: PrincipalType, id: string) => {
    for (const node of chain) {
      const g = node.grants.find((x) => x.principalType === type && x.principalId === id);
      if (g) return g.role; // nearest grant for this principal wins
    }
    return null;
  };
  role = maxRole(role, nearest('user', userId));

  if (workspaceRole) {
    const restricted = team && chain.some((n) => n.restricted);
    if (!restricted) {
      const shared = nearest('workspace', workspaceId);
      if (team) {
        const base = TEAM_BASELINE[workspaceRole];
        role = maxRole(role, base === 'owner' ? base : (shared ?? base));
      } else {
        role = maxRole(role, shared);
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
