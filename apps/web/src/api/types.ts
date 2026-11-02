/** Web-side view of the API: shared wire types plus a few web-only shapes. */
export type * from '@bee/shared';
export type { MeResponse as Session } from '@bee/shared';
import type {
  ApiTokenDTO,
  CommentAnchor,
  ConnectedAppDTO,
  CreateTokenResponse,
  CommentThreadDTO,
  DocumentDTO,
  DocumentType,
  FolderDTO,
  GrantableRole,
  LinkRole,
  SharingDTO,
  ShareLinkDTO,
  TreeDTO,
  VersionDTO,
  VersionContentResponse,
  MeResponse,
  AuthProvidersResponse,
  UpdateMeBody,
  ActivityItem,
  SearchResponse,
  ShareResolveResponse,
  TrashResponse,
  UploadResponse,
  NotificationsResponse,
  NotificationDTO,
  TemplateDTO,
  AccessRequestDTO,
  LinkPreviewResponse,
  UserRef,
} from '@bee/shared';

/** A version's full content, for diff and preview. `content` is ProseMirror JSON. */
export type VersionContent = VersionContentResponse;
export type ActivityDTO = ActivityItem;
export type SearchHit = SearchResponse['results'][number];
export type SharedDocDTO = ShareResolveResponse;

export interface BeeApi {
  /** Share token for anonymous /s/:token visitors; sent as x-share-token. */
  shareToken: string | null;
  me(): Promise<MeResponse | null>;
  login(email: string, password: string): Promise<MeResponse>;
  register(name: string, email: string, password: string): Promise<MeResponse>;
  authProviders(): Promise<AuthProvidersResponse>;
  setupAccount(name: string, password: string): Promise<MeResponse>;
  logout(): Promise<void>;
  updateMe(patch: UpdateMeBody): Promise<MeResponse>;
  uploadAvatar(image: Blob): Promise<MeResponse>;
  removeAvatar(): Promise<MeResponse>;

  tree(workspaceId: string): Promise<TreeDTO>;
  search(workspaceId: string, q: string): Promise<SearchHit[]>;
  trash(workspaceId: string): Promise<TrashResponse>;
  recent(workspaceId: string): Promise<DocumentDTO[]>;
  sharedWithMe(): Promise<DocumentDTO[]>;

  createFolder(input: { workspaceId: string; parentId: string | null; name: string }): Promise<FolderDTO>;
  updateFolder(id: string, patch: { name?: string; parentId?: string | null; sort?: number }): Promise<FolderDTO>;
  deleteFolder(id: string): Promise<void>;

  createDocument(input: {
    workspaceId: string;
    folderId: string | null;
    type: DocumentType;
    title: string;
    markdown?: string;
    /** set for whiteboards embedded in a document */
    parentDocumentId?: string;
  }): Promise<DocumentDTO>;
  getDocument(id: string): Promise<DocumentDTO>;
  /** Stored Yjs state (null when empty), for rendering before the collab sync. */
  documentState(id: string): Promise<Uint8Array | null>;
  updateDocument(id: string, patch: { title?: string; folderId?: string | null; sort?: number }): Promise<DocumentDTO>;
  deleteDocument(id: string): Promise<void>;
  restoreDocument(id: string): Promise<DocumentDTO>;
  /** link a standalone whiteboard into a document (readers of the document may then view it) */
  embedDocument(docId: string, embeddedId: string): Promise<void>;
  restoreFolder(id: string): Promise<void>;
  upload(docId: string, file: File): Promise<UploadResponse>;
  /** multipart: body, meta (JSON), images */
  reportBug(form: FormData): Promise<{ id: number }>;
  blockExists(docId: string, blockId: string): Promise<boolean>;

  versions(docId: string): Promise<VersionDTO[]>;
  createVersion(docId: string, label?: string): Promise<VersionDTO>;
  renameVersion(docId: string, versionId: string, label: string): Promise<VersionDTO>;
  versionContent(docId: string, versionId: string): Promise<VersionContent>;
  restoreVersion(docId: string, versionId: string): Promise<void>;

  threads(docId: string): Promise<CommentThreadDTO[]>;
  /** `guestName` is required for anonymous visitors on a link with guest comments */
  createThread(docId: string, anchor: CommentAnchor | null, body: string, guestName?: string): Promise<CommentThreadDTO>;
  reply(threadId: string, body: string, guestName?: string): Promise<void>;
  deleteComment(commentId: string): Promise<void>;
  setResolved(threadId: string, resolved: boolean): Promise<CommentThreadDTO>;

  sharing(docId: string): Promise<SharingDTO>;
  addGrant(docId: string, email: string, role: GrantableRole): Promise<void>;
  updateGrant(grantId: string, role: GrantableRole): Promise<void>;
  removeGrant(grantId: string): Promise<void>;
  createLink(docId: string, role: LinkRole, isPublic: boolean, guestComments?: boolean): Promise<ShareLinkDTO>;
  updateLink(linkId: string, patch: { role?: LinkRole; public?: boolean; guestComments?: boolean }): Promise<ShareLinkDTO>;
  deleteLink(linkId: string): Promise<void>;
  resolveShare(token: string): Promise<SharedDocDTO>;

  activity(docId: string): Promise<ActivityDTO[]>;

  tokens(): Promise<ApiTokenDTO[]>;
  /** The secret is only returned here, once. */
  createToken(name: string): Promise<CreateTokenResponse>;
  deleteToken(id: string): Promise<void>;
  connectedApps(): Promise<ConnectedAppDTO[]>;
  revokeApp(id: string): Promise<void>;

  starred(workspaceId: string): Promise<DocumentDTO[]>;
  setStar(docId: string, starred: boolean): Promise<void>;
  duplicateDocument(docId: string): Promise<DocumentDTO>;
  /** Markdown export with the title as the first heading */
  exportMarkdown(docId: string): Promise<Blob>;
  editMarkdown(docId: string, markdown: string): Promise<void>;
  linkPreview(docId: string, blockId?: string | null): Promise<LinkPreviewResponse>;

  mentionable(docId: string, q: string): Promise<(UserRef & { email: string })[]>;
  notifications(opts?: { unread?: boolean; before?: string }): Promise<NotificationsResponse>;
  unreadCount(): Promise<number>;
  markRead(ids: string[] | 'all'): Promise<number>;
  delivery(): Promise<{ email: boolean; push: boolean; vapidPublicKey: string | null }>;
  savePush(sub: PushSubscriptionJSON): Promise<void>;
  removePush(endpoint: string): Promise<void>;
  testPush(): Promise<void>;

  requestAccess(docId: string, role: GrantableRole, message?: string): Promise<AccessRequestDTO>;
  myAccessRequest(docId: string): Promise<AccessRequestDTO | null>;
  handleAccessRequest(id: string, action: { action: 'grant'; role: GrantableRole } | { action: 'decline' }): Promise<AccessRequestDTO>;

  templates(workspaceId: string): Promise<TemplateDTO[]>;
  saveTemplate(docId: string, title?: string): Promise<TemplateDTO>;
  deleteTemplate(id: string): Promise<void>;
}

export type { NotificationDTO, TemplateDTO, AccessRequestDTO };
