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
  ActivityItem,
  SearchResponse,
  ShareResolveResponse,
  TrashResponse,
  UploadResponse,
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
  logout(): Promise<void>;

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
  updateDocument(id: string, patch: { title?: string; folderId?: string | null; sort?: number }): Promise<DocumentDTO>;
  deleteDocument(id: string): Promise<void>;
  restoreDocument(id: string): Promise<DocumentDTO>;
  restoreFolder(id: string): Promise<void>;
  upload(docId: string, file: File): Promise<UploadResponse>;
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
}
