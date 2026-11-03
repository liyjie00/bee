/**
 * Wire types for the HTTP API (apps/api). Dates are ISO strings.
 * All routes live under /api. Errors are `{ error: { code, message } }`.
 */
import type {
  GrantableRole,
  LinkRole,
  PrincipalType,
  Role,
  WorkspaceKind,
  WorkspaceRole,
} from './permissions.js';

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
  prefs: UserPrefs;
  /** signed up with Google: must choose a name and password before using Bee */
  setupRequired: boolean;
}

export const DOC_FONT_SIZES = ['small', 'medium', 'large'] as const;
export type DocFontSize = (typeof DOC_FONT_SIZES)[number];
export const DOC_FONTS = ['sans', 'serif', 'mono'] as const;
export type DocFont = (typeof DOC_FONTS)[number];

/** Avatar / cursor colors a user can pick; new accounts get one of them. */
export const USER_COLORS = [
  '#E5484D',
  '#F76B15',
  '#FFC53D',
  '#46A758',
  '#12A594',
  '#0090FF',
  '#3E63DD',
  '#8E4EC6',
  '#D6409F',
] as const;

/** Per-user reading preferences; missing keys mean the default (medium / sans). */
export interface UserPrefs {
  docFontSize?: DocFontSize;
  docFont?: DocFont;
  /** UI language, also used for emails and browser notifications */
  lang?: 'zh-CN' | 'en';
  /** email digests of notifications (default on) */
  emailNotifications?: boolean;
  /** kinds that neither email nor push (they still show in the inbox) */
  mutedNotifications?: NotificationKind[];
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
  kind: WorkspaceKind;
  /** tile color of a team */
  color: string;
  role: WorkspaceRole;
  memberCount: number;
  createdAt: string;
}

/** Colors a team tile can take. */
export const TEAM_COLORS = ['#c2410c', '#3b7dd8', '#7c3aed', '#1e6b2a', '#e8a317', '#4a5146'] as const;

/** Roles an invitation can give (owners promote people after they join). */
export const INVITE_ROLES = ['editor', 'viewer'] as const;
export type InviteRole = (typeof INVITE_ROLES)[number];

/** A pending invitation by email. */
export interface TeamInviteDTO {
  id: string;
  email: string;
  role: InviteRole;
  invitedBy: UserRef | null;
  createdAt: string;
  expiresAt: string;
}

/** The team's join link (one per team). `url` is null while the link is off. */
export interface TeamLinkDTO {
  url: string | null;
  role: InviteRole;
}

/** What an invitation page shows before the visitor accepts. */
export interface InvitePreviewDTO {
  workspace: { id: string; name: string; color: string; memberCount: number };
  role: InviteRole;
  invitedBy: UserRef | null;
  /** email invitations: the address it was sent to */
  email: string | null;
  /** the visitor is already a member */
  member: boolean;
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
  /** team folders hidden from members who were not added */
  restricted: boolean;
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
  /** absolute URL, e.g. https://docs.example.com/s/<token> */
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

export const NOTIFICATION_KINDS = [
  'mention',
  'reply',
  'share',
  'access_request',
  'team_invite',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface AccessRequestDTO {
  id: string;
  documentId: string;
  user: UserRef & { email: string };
  role: GrantableRole;
  message: string | null;
  status: 'pending' | 'granted' | 'declined';
  grantedRole: GrantableRole | null;
  createdAt: string;
}

export interface NotificationDTO {
  id: string;
  kind: NotificationKind;
  /** the space it happened in */
  workspace: { id: string; name: string; kind: WorkspaceKind; color: string } | null;
  /** for guests: id '' and the guest's nickname */
  actor: UserRef | null;
  document: { id: string; title: string; type: DocumentType } | null;
  folder: { id: string; name: string } | null;
  threadId: string | null;
  /** comment text (mention, reply) or the granted role (share) */
  detail: string | null;
  /** access_request: the request, with its current status */
  request: AccessRequestDTO | null;
  read: boolean;
  createdAt: string;
}

export interface TemplateDTO {
  id: string;
  workspaceId: string;
  title: string;
  markdown: string;
  createdBy: UserRef | null;
  /** the caller may delete it (its creator, or a workspace admin) */
  canDelete: boolean;
  createdAt: string;
}
