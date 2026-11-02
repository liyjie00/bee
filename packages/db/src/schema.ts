import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  CommentAnchor,
  DocumentType,
  GrantableRole,
  LinkRole,
  PrincipalType,
  ResourceType,
  WorkspaceRole,
} from '@bee/shared';

/** Postgres bytea <-> Node Buffer (Yjs updates and snapshots). */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    email: text('email').notNull(),
    name: text('name').notNull(),
    passwordHash: text('password_hash').notNull(),
    avatarUrl: text('avatar_url'),
    color: text('color').notNull(),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_key').on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  'sessions',
  {
    /** sha256 of the cookie token */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: ts('expires_at').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
});

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').$type<WorkspaceRole>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), index('wm_user_idx').on(t.userId)],
);

export const folders = pgTable(
  'folders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id'),
    name: text('name').notNull(),
    sort: doublePrecision('sort').notNull().default(0),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('folders_ws_parent_idx').on(t.workspaceId, t.parentId),
    foreignKey({
      columns: [t.parentId],
      foreignColumns: [t.id],
      name: 'folders_parent_fk',
    }).onDelete('cascade'),
  ],
);

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    folderId: uuid('folder_id').references(() => folders.id, { onDelete: 'set null' }),
    /**
     * Set for content embedded in another document (e.g. a whiteboard inside a doc):
     * it inherits the parent's access and is hidden from the folder tree.
     */
    parentDocumentId: uuid('parent_document_id'),
    type: text('type').$type<DocumentType>().notNull().default('doc'),
    title: text('title').notNull().default(''),
    icon: text('icon'),
    sort: doublePrecision('sort').notNull().default(0),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    /** Standard Yjs update (Y.encodeStateAsUpdate) — the source of truth. */
    ydocState: bytea('ydoc_state'),
    /** Markdown rendering for search / export. */
    markdownCache: text('markdown_cache'),
    /** Plain text, derived from ydoc_state, for search and snippets. */
    textCache: text('text_cache'),
    /** blockIds present in the latest state, for anchor-link existence checks. */
    blockIds: text('block_ids')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    lastEditedById: uuid('last_edited_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().defaultNow(),
    contentUpdatedAt: ts('content_updated_at'),
    deletedAt: ts('deleted_at'),
  },
  (t) => [
    index('documents_ws_folder_idx').on(t.workspaceId, t.folderId),
    index('documents_parent_idx').on(t.parentDocumentId),
    foreignKey({
      columns: [t.parentDocumentId],
      foreignColumns: [t.id],
      name: 'documents_parent_fk',
    }).onDelete('cascade'),
    index('documents_search_idx').using(
      'gin',
      sql`to_tsvector('simple', coalesce(${t.title}, '') || ' ' || coalesce(${t.textCache}, ''))`,
    ),
  ],
);

/** Grants on folders (inherited downward) and documents (override). */
export const permissions = pgTable(
  'permissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    resourceType: text('resource_type').$type<ResourceType>().notNull(),
    resourceId: uuid('resource_id').notNull(),
    principalType: text('principal_type').$type<PrincipalType>().notNull(),
    principalId: uuid('principal_id').notNull(),
    role: text('role').$type<GrantableRole>().notNull(),
    createdById: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('permissions_unique').on(
      t.resourceType,
      t.resourceId,
      t.principalType,
      t.principalId,
    ),
    index('permissions_principal_idx').on(t.principalType, t.principalId),
  ],
);

export const shareLinks = pgTable(
  'share_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    role: text('role').$type<LinkRole>().notNull(),
    public: boolean('public').notNull().default(true),
    /** public links only: visitors may comment without signing in, under a nickname */
    guestComments: boolean('guest_comments').notNull().default(false),
    expiresAt: ts('expires_at'),
    createdById: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [index('share_links_doc_idx').on(t.documentId)],
);

export const commentThreads = pgTable(
  'comment_threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    anchor: jsonb('anchor').$type<CommentAnchor>(),
    /** null when a guest (anonymous share-link visitor) started the thread */
    createdById: uuid('created_by').references(() => users.id),
    createdAt: createdAt(),
    resolvedAt: ts('resolved_at'),
    resolvedById: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [index('threads_doc_idx').on(t.documentId)],
);

export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => commentThreads.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    /** null for guest comments, which carry guestName instead */
    authorId: uuid('author_id').references(() => users.id),
    guestName: text('guest_name'),
    /** sha256 of the guest's browser key, so guests can delete their own comments */
    guestKeyHash: text('guest_key_hash'),
    /** share link a guest comment came through */
    shareLinkId: uuid('share_link_id').references(() => shareLinks.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    createdAt: createdAt(),
    editedAt: ts('edited_at'),
  },
  (t) => [index('comments_thread_idx').on(t.threadId)],
);

export const documentVersions = pgTable(
  'document_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    /** Full Yjs update at this point in time. */
    snapshot: bytea('snapshot').notNull(),
    label: text('label'),
    kind: text('kind').$type<'auto' | 'manual' | 'restore'>().notNull().default('auto'),
    authorIds: uuid('author_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    createdById: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('versions_doc_idx').on(t.documentId, t.createdAt)],
);

export const uploads = pgTable(
  'uploads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),
    filename: text('filename').notNull(),
    mime: text('mime').notNull(),
    size: integer('size').notNull(),
    storageKey: text('storage_key').notNull(),
    createdById: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('uploads_doc_idx').on(t.documentId)],
);

export const activity = pgTable(
  'activity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'set null' }),
    kind: text('kind').notNull(),
    detail: text('detail'),
    createdAt: createdAt(),
  },
  (t) => [index('activity_doc_idx').on(t.documentId, t.createdAt)],
);

/** Per-user "last opened" for the Recent list. */
export const documentViews = pgTable(
  'document_views',
  {
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    viewedAt: ts('viewed_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.documentId, t.userId] }),
    index('views_user_idx').on(t.userId, t.viewedAt),
  ],
);

/** OAuth clients registered through dynamic client registration (e.g. Claude connectors). */
export const oauthClients = pgTable('oauth_clients', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  redirectUris: jsonb('redirect_uris').$type<string[]>().notNull(),
  createdAt: createdAt(),
});

/** Short-lived OAuth authorization codes (PKCE S256). */
export const oauthCodes = pgTable('oauth_codes', {
  /** sha256 of the code */
  id: text('id').primaryKey(),
  clientId: text('client_id')
    .notNull()
    .references(() => oauthClients.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  redirectUri: text('redirect_uri').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  resource: text('resource'),
  expiresAt: ts('expires_at').notNull(),
  createdAt: createdAt(),
});

/**
 * Bearer tokens: personal API tokens created in Settings, and OAuth access/refresh
 * tokens. Tokens of one OAuth authorization share a `grantId`, so revoking a
 * connected app removes all of them.
 */
export const apiTokens = pgTable(
  'api_tokens',
  {
    /** sha256 of the token */
    id: text('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<'personal' | 'oauth_access' | 'oauth_refresh'>().notNull(),
    name: text('name').notNull(),
    /** first characters of the token, shown in Settings */
    prefix: text('prefix').notNull(),
    clientId: text('client_id').references(() => oauthClients.id, { onDelete: 'cascade' }),
    grantId: uuid('grant_id'),
    expiresAt: ts('expires_at'),
    lastUsedAt: ts('last_used_at'),
    createdAt: createdAt(),
  },
  (t) => [index('api_tokens_user_idx').on(t.userId), index('api_tokens_grant_idx').on(t.grantId)],
);
