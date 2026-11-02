/**
 * HTTP route contract for apps/api. Everything is JSON unless noted, under /api,
 * authenticated by the `bee_session` cookie (set by login/register), or by
 * `Authorization: Bearer <token>` (personal API token or OAuth access token).
 * Errors: `ApiError` with status 400 (validation), 401 (not signed in),
 * 403 (no access), 404 (missing / no read access), 409 (conflict).
 *
 * Endpoints that accept a share token read it from the `x-share-token` header
 * (or `?share=` query), so anonymous visitors of /s/:token can read the doc,
 * its versions and comments.
 */
import type {
  ApiTokenDTO,
  BlockLinkDTO,
  CommentAnchor,
  CommentDTO,
  AccessRequestDTO,
  NotificationDTO,
  TemplateDTO,
  CommentThreadDTO,
  ConnectedAppDTO,
  DocumentDTO,
  DocumentType,
  FolderDTO,
  GrantDTO,
  ShareLinkDTO,
  SharingDTO,
  TreeDTO,
  UserDTO,
  UserPrefs,
  UserRef,
  VersionDTO,
  WorkspaceDTO,
  WorkspaceMemberDTO,
} from './api.js';
import type { GrantableRole, LinkRole, Role, WorkspaceRole } from './permissions.js';

export interface Ok {
  ok: true;
}

// ---------- auth ----------
/** POST /api/auth/register */
export interface RegisterBody {
  email: string;
  password: string; // min 8 chars
  name: string;
}
/** POST /api/auth/login */
export interface LoginBody {
  email: string;
  password: string;
}
/** POST /api/auth/register | /api/auth/login | GET /api/auth/me */
export interface MeResponse {
  user: UserDTO;
  workspaces: WorkspaceDTO[];
}
/** POST /api/auth/logout → Ok */
/** PATCH /api/auth/me */
export interface UpdateMeBody {
  name?: string;
  avatarUrl?: string | null;
  color?: string;
  /** Merged into the stored prefs. */
  prefs?: UserPrefs;
}
/** GET /api/auth/providers: sign-in methods besides email + password */
export interface AuthProvidersResponse {
  google: boolean;
}
/** GET /api/auth/google?next=/path → redirect to Google; back at /api/auth/google/callback */
/** POST /api/auth/setup (only while user.setupRequired) → MeResponse */
export interface AccountSetupBody {
  name: string;
  password: string; // min 8 chars
}
/** POST /api/auth/password */
export interface ChangePasswordBody {
  currentPassword: string;
  newPassword: string;
}

// ---------- workspaces ----------
/** GET /api/workspaces → { workspaces } */
export interface WorkspacesResponse {
  workspaces: WorkspaceDTO[];
}
/** POST /api/workspaces → { workspace } ; PATCH /api/workspaces/:id */
export interface WorkspaceBody {
  name: string;
}
export interface WorkspaceResponse {
  workspace: WorkspaceDTO;
}
/** GET /api/workspaces/:id/members */
export interface MembersResponse {
  members: WorkspaceMemberDTO[];
}
/** POST /api/workspaces/:id/members (user must already have an account) */
export interface AddMemberBody {
  email: string;
  role: WorkspaceRole;
}
/** PATCH /api/workspaces/:id/members/:userId { role } ; DELETE → Ok */

/** GET /api/workspaces/:id/tree → TreeDTO (only what the caller can read) */
export type TreeResponse = TreeDTO;
/** GET /api/workspaces/:id/search?q= */
export interface SearchResponse {
  results: { document: DocumentDTO; snippet: string }[];
}
/** GET /api/workspaces/:id/trash → documents the caller owns that are soft-deleted */
export interface TrashResponse {
  documents: DocumentDTO[];
  folders: FolderDTO[];
}
/** GET /api/workspaces/:id/recent */
export interface RecentResponse {
  documents: DocumentDTO[];
}
/** GET /api/workspaces/:id/starred → { documents } (newest star first) ; PUT|DELETE /api/documents/:id/star → Ok */
export type StarredResponse = RecentResponse;
/** GET /api/workspaces/:id/shared-with-me */
export type SharedWithMeResponse = RecentResponse;

// ---------- folders ----------
/** POST /api/folders → { folder } */
export interface CreateFolderBody {
  workspaceId: string;
  parentId?: string | null;
  name: string;
}
/** PATCH /api/folders/:id → { folder } (move = set parentId; reorder = set sort) */
export interface UpdateFolderBody {
  name?: string;
  parentId?: string | null;
  sort?: number;
}
export interface FolderResponse {
  folder: FolderDTO;
}
/** DELETE /api/folders/:id → Ok (soft delete, with contents) ; POST /api/folders/:id/restore */
/** GET /api/folders/:id/sharing → SharingDTO (links always empty) ; grants as for documents */

// ---------- documents ----------
/** POST /api/documents → { document } */
export interface CreateDocumentBody {
  /** optional when parentDocumentId is set */
  workspaceId?: string;
  /** embed in another document, e.g. a whiteboard inside a doc (needs edit on the parent) */
  parentDocumentId?: string;
  folderId?: string | null;
  title?: string;
  type?: DocumentType;
  /** optional initial content as Markdown (import) */
  markdown?: string;
}
/** GET /api/documents/:id → { document } */
export interface DocumentResponse {
  document: DocumentDTO;
}
/** PATCH /api/documents/:id → { document } */
export interface UpdateDocumentBody {
  title?: string;
  icon?: string | null;
  folderId?: string | null;
  sort?: number;
}
/** DELETE /api/documents/:id → Ok (to trash; ?permanent=1 hard delete, owner only, from trash) */
/** POST /api/documents/:id/restore → { document } (from trash) */
/** POST /api/documents/:id/duplicate → { document } */
/**
 * POST /api/documents/:id/embeds { documentId } → Ok (editor role on :id; read on the whiteboard).
 * Links a standalone whiteboard of the same workspace into the document: readers of the document
 * (including through its share links) may view the whiteboard while the document embeds it.
 */
export interface EmbedDocumentBody {
  documentId: string;
}
/** GET /api/documents/:id/export.md → text/markdown */
/** GET /api/documents/:id/markdown → live content as Markdown (docs only) */
export interface MarkdownResponse {
  documentId: string;
  title: string;
  markdown: string;
}
/**
 * POST /api/documents/:id/markdown → MarkdownEditResponse (editor role; docs only).
 * Applied through the collab server as ordinary Yjs edits, so open editors update live.
 * replace: the document becomes `markdown` (unchanged blocks, their ids and comments are kept);
 * append: `markdown` is added at the end;
 * str_replace: `find` (exact text of the current Markdown) becomes `replace`; 409 when it does
 * not occur, or occurs more than once without `replaceAll`.
 */
export type MarkdownEditBody =
  | { mode: 'replace' | 'append'; markdown: string }
  | { mode: 'str_replace'; find: string; replace: string; replaceAll?: boolean };
export interface MarkdownEditResponse extends MarkdownResponse {
  kept: number;
  removed: number;
  inserted: number;
  occurrences?: number;
}
/** GET /api/documents/:id/link-preview?block= → LinkPreviewResponse (read access) */
export interface LinkPreviewResponse {
  documentId: string;
  title: string;
  type: DocumentType;
  /** heading the block sits under, when `block` is given */
  section: string | null;
}
/** GET /api/documents/:id/blocks/:blockId → BlockLinkDTO */
export type BlockLinkResponse = BlockLinkDTO;

/**
 * GET /api/documents/:id/whiteboard → { documentId, title, description, elements } (whiteboards;
 * `elements` are the live Excalidraw elements, `description` a plain-text summary)
 * POST /api/documents/:id/diagram (editor role; whiteboards) → DiagramResponse
 * Draws nodes as shapes with bound labels and edges as bound arrows, laid out in layers.
 */
export interface DiagramBody {
  nodes: {
    id: string;
    label: string;
    shape?: 'rectangle' | 'ellipse' | 'diamond';
    color?: string;
    x?: number;
    y?: number;
  }[];
  edges?: { from: string; to: string; label?: string; dashed?: boolean }[];
  direction?: 'down' | 'right';
  /** append (default): below what is on the board; replace: clear the board first */
  mode?: 'append' | 'replace';
}
export interface DiagramResponse {
  documentId: string;
  added: number;
  removed: number;
  shapes: number;
  arrows: number;
}

// ---------- versions ----------
/** GET /api/documents/:id/versions */
export interface VersionsResponse {
  versions: VersionDTO[];
}
/** POST /api/documents/:id/versions { label? } → { version } (snapshot of current state) */
export interface CreateVersionBody {
  label?: string;
}
export interface VersionResponse {
  version: VersionDTO;
}
/** GET /api/documents/:id/versions/:vid */
export interface VersionContentResponse {
  version: VersionDTO;
  /** ProseMirror JSON of the 'default' fragment (docs) */
  content: unknown;
  /** plain text, for quick diffing */
  text: string;
}
/** GET /api/documents/:id/versions/current → VersionContentResponse of the live state (version.id = 'current') */
/** PATCH /api/documents/:id/versions/:vid { label } → { version } */
/** POST /api/documents/:id/versions/:vid/restore → { version } (the new head version) */

// ---------- comments ----------
/** GET /api/documents/:id/threads?resolved=0|1 */
export interface ThreadsResponse {
  threads: CommentThreadDTO[];
}
/** POST /api/documents/:id/threads → { thread } */
export interface CreateThreadBody {
  anchor: CommentAnchor | null; // null = document-level comment
  body: string;
}
export interface ThreadResponse {
  thread: CommentThreadDTO;
}
/** POST /api/threads/:tid/comments → { comment } */
export interface CreateCommentBody {
  body: string;
}
export interface CommentResponse {
  comment: CommentDTO;
}
/** PATCH /api/threads/:tid { resolved } → { thread } */
export interface UpdateThreadBody {
  resolved: boolean;
}
/** DELETE /api/threads/:tid → Ok (thread author or doc owner) */
/** PATCH /api/comments/:cid { body } → { comment } ; DELETE /api/comments/:cid → Ok */

// ---------- sharing ----------
/** GET /api/documents/:id/sharing → SharingDTO */
export type SharingResponse = SharingDTO;
/**
 * POST /api/documents/:id/grants (also /api/folders/:id/grants) → { grant }
 * email: grant to one user; workspace: true grants to all workspace members.
 */
export interface CreateGrantBody {
  email?: string;
  workspace?: boolean;
  role: GrantableRole;
}
export interface GrantResponse {
  grant: GrantDTO;
}
/** PATCH /api/grants/:id { role } → { grant } ; DELETE /api/grants/:id → Ok */
export interface UpdateGrantBody {
  role: GrantableRole;
}
/** POST /api/documents/:id/links → { link } */
export interface CreateLinkBody {
  role: LinkRole;
  /** true: anyone with the link; false: must be signed in */
  public: boolean;
  expiresAt?: string | null;
}
export interface LinkResponse {
  link: ShareLinkDTO;
}
/** PATCH /api/links/:id { role?, public?, expiresAt? } → { link } ; DELETE /api/links/:id → Ok */

/** GET /api/share/:token (no auth needed for public links) */
export interface ShareResolveResponse {
  document: DocumentDTO;
  role: Role;
}

// ---------- activity ----------
/** GET /api/documents/:id/activity */
export interface ActivityItem {
  id: string;
  kind:
    | 'created'
    | 'edited'
    | 'commented'
    | 'resolved'
    | 'shared'
    | 'version'
    | 'restored'
    | 'moved'
    | 'renamed';
  actor: UserRef | null;
  createdAt: string;
  detail: string | null;
}
export interface ActivityResponse {
  items: ActivityItem[];
}

// ---------- API tokens (browser session only) ----------
/** GET /api/tokens → { tokens } */
export interface TokensResponse {
  tokens: ApiTokenDTO[];
}
/** POST /api/tokens { name } → { token, secret } (secret is shown once) ; DELETE /api/tokens/:id → Ok */
export interface CreateTokenBody {
  name: string;
}
export interface CreateTokenResponse {
  token: ApiTokenDTO;
  secret: string;
}
/** GET /api/connected-apps → { apps } ; DELETE /api/connected-apps/:id → Ok (revokes the grant) */
export interface ConnectedAppsResponse {
  apps: ConnectedAppDTO[];
}

// ---------- MCP and OAuth (outside /api) ----------
/**
 * POST /mcp  MCP Streamable HTTP endpoint (stateless, JSON responses), Authorization: Bearer
 *            <personal token | OAuth access token>; 401 carries WWW-Authenticate resource_metadata.
 * GET  /.well-known/oauth-protected-resource[/mcp], /.well-known/oauth-authorization-server
 * POST /oauth/register (RFC 7591), GET|POST /oauth/authorize (consent page, PKCE S256),
 * POST /oauth/token (authorization_code | refresh_token), POST /oauth/revoke
 */

// ---------- uploads ----------
/** POST /api/documents/:id/uploads (multipart, field "file") → { url } ; GET /api/uploads/:id (authorized by doc) */
export interface UploadResponse {
  id: string;
  url: string;
  filename: string;
  mime: string;
  size: number;
}

// ---------- internal (collab server only; header x-collab-secret) ----------
/**
 * POST /api/internal/collab/auth  CollabAuthRequest → CollabAuthResponse | 401/403/404
 * GET  /api/internal/collab/documents/:id/state   → octet-stream Yjs update | 204 empty
 * PUT  /api/internal/collab/documents/:id/state   octet-stream full update → 204
 *      (optional header x-author-ids: id1,id2 updates last_edited_by)
 * PUT  /api/internal/collab/documents/:id/markdown text/markdown → 204 (optional)
 * POST /api/internal/collab/documents/:id/versions octet-stream, header x-author-ids → 201
 */

// ---------- mentions and notifications ----------
/** GET /api/documents/:id/mentionable?q= → people who can read the document (for @mentions) */
export interface MentionableResponse {
  users: (UserRef & { email: string })[];
}
/** GET /api/notifications?unread=1&before=<iso> → newest first, 50 per page */
export interface NotificationsResponse {
  notifications: NotificationDTO[];
  unread: number;
}
/** GET /api/notifications/unread → { unread } */
/** POST /api/notifications/read { ids } | { all: true } → { unread } */
export interface ReadNotificationsBody {
  ids?: string[];
  all?: boolean;
}

// ---------- templates ----------
/** GET /api/workspaces/:id/templates → { templates } */
export interface TemplatesResponse {
  templates: TemplateDTO[];
}
/** POST /api/documents/:id/template { title? } → { template } (docs; read access) ; DELETE /api/templates/:id → Ok */
export interface TemplateResponse {
  template: TemplateDTO;
}

// ---------- access requests ----------
/**
 * POST /api/documents/:id/access-requests { role, message? } → { request } (signed in, no read access
 * yet; 409 already_has_access). Editors and the owner get an access_request notification.
 * GET /api/documents/:id/access-requests/mine → { request: AccessRequestDTO | null }
 * POST /api/access-requests/:id { action: 'grant', role } | { action: 'decline' } → { request } (editors)
 */
export interface CreateAccessRequestBody {
  role: GrantableRole;
  message?: string;
}
export interface AccessRequestResponse {
  request: AccessRequestDTO | null;
}
export type HandleAccessRequestBody =
  { action: 'grant'; role: GrantableRole } | { action: 'decline' };
