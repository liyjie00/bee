/**
 * Wire types for the HTTP API (apps/api). Dates are ISO strings.
 * All routes live under /api. Errors are `{ error: { code, message } }`.
 */
import type { GrantableRole, LinkRole, PrincipalType, Role, WorkspaceRole } from './permissions.js';

export type DocumentType = 'doc' | 'whiteboard' | 'sheet';

export interface ApiError {
  error: { code: string; message: string };
}

export interface UserDTO {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  color: string;
  createdAt: string;
}

/** Minimal user info shown next to comments, versions, members. */
export interface UserRef {
  id: string;
  name: string;
  avatarUrl: string | null;
  color: string;
}

export interface WorkspaceDTO {
  id: string;
  name: string;
  slug: string;
  role: WorkspaceRole;
  createdAt: string;
}

export interface WorkspaceMemberDTO {
  user: UserRef & { email: string };
  role: WorkspaceRole;
  joinedAt: string;
}

export interface FolderDTO {
  id: string;
  workspaceId: string;
  parentId: string | null;
  name: string;
  sort: number;
  ownerId: string;
  role: Role;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentDTO {
  id: string;
  workspaceId: string;
  folderId: string | null;
  /** set for content embedded in another document (inherits its access, not in the tree) */
  parentDocumentId: string | null;
  type: DocumentType;
  title: string;
  icon: string | null;
  sort: number;
  owner: UserRef;
  /** caller's effective role */
  role: Role;
  createdAt: string;
  updatedAt: string;
  lastEditedBy: UserRef | null;
  deletedAt: string | null;
}

/** Folder tree entry for the sidebar: GET /api/workspaces/:id/tree */
export interface TreeDTO {
  folders: FolderDTO[];
  documents: DocumentDTO[];
}

export interface GrantDTO {
  id: string;
  principalType: PrincipalType;
  /** set when principalType is 'user' */
  user: (UserRef & { email: string }) | null;
  role: GrantableRole;
  /** true when inherited from an ancestor folder (read-only in this view) */
  inherited: boolean;
  /** folder the grant comes from when inherited */
  sourceFolderId: string | null;
}

export interface ShareLinkDTO {
  id: string;
  documentId: string;
  token: string;
  role: LinkRole;
  /** anyone with the link (no login); false = signed-in workspace members only */
  public: boolean;
  /** public links only: anyone with the link can comment under a nickname, without signing in */
  guestComments: boolean;
  expiresAt: string | null;
  createdAt: string;
  /** absolute URL, e.g. https://bee.zippyzoo.dev/s/<token> */
  url: string;
}

export interface SharingDTO {
  grants: GrantDTO[];
  links: ShareLinkDTO[];
}

/**
 * Comment anchor, opaque to the API. Positions are Y.RelativePosition JSON so
 * they survive concurrent edits. The anchor is not stored in the Yjs doc.
 */
export interface CommentAnchor {
  blockId: string;
  from: unknown;
  to: unknown;
  quote: string;
}

export interface CommentDTO {
  id: string;
  documentId: string;
  threadId: string;
  /** set only on the first comment of a thread */
  anchor: CommentAnchor | null;
  body: string;
  /** for guest comments: id '' and the guest's nickname */
  author: UserRef;
  /** written by an anonymous share-link visitor */
  guest: boolean;
  /** the caller may delete it (their own comment, or they own the document) */
  canDelete: boolean;
  createdAt: string;
  editedAt: string | null;
}

export interface CommentThreadDTO {
  id: string;
  documentId: string;
  anchor: CommentAnchor | null;
  resolved: boolean;
  resolvedBy: UserRef | null;
  resolvedAt: string | null;
  comments: CommentDTO[];
  createdAt: string;
}

export interface VersionDTO {
  id: string;
  documentId: string;
  label: string | null;
  authors: UserRef[];
  createdAt: string;
  /** 'auto' from the collab server, 'manual' when a user named it, 'restore' before a restore */
  kind: 'auto' | 'manual' | 'restore';
}

/** Result of resolving a block anchor link /d/:docId#b-:blockId */
export interface BlockLinkDTO {
  documentId: string;
  blockId: string;
  exists: boolean;
}

/** Collab server <-> API internal contract (header x-collab-secret). */
export interface CollabAuthRequest {
  documentId: string;
  /** raw Cookie header from the WebSocket upgrade */
  cookie?: string;
  shareToken?: string;
}

export interface CollabAuthResponse {
  user: { id: string; name: string; color?: string } | null;
  role: Role;
  readOnly: boolean;
  documentType: DocumentType;
}

/** A personal API token (the secret is only returned once, on creation). */
export interface ApiTokenDTO {
  id: string;
  name: string;
  /** first characters of the token, e.g. "bee_pat_AbCd" */
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** An app authorized through OAuth (e.g. a Claude connector). `id` is the grant id. */
export interface ConnectedAppDTO {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
}
