import type {
  ActivityResponse,
  BeeApi,
  DocumentResponse,
  FolderResponse,
  LinkResponse,
  MeResponse,
  RecentResponse,
  SearchResponse,
  ThreadResponse,
  ThreadsResponse,
  VersionResponse,
  VersionsResponse,
  BlockLinkResponse,
} from './types';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined && !(body instanceof FormData)) headers['content-type'] = 'application/json';
  if (api.shareToken) headers['x-share-token'] = api.shareToken;
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers,
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new HttpError(res.status, e?.code ?? `http_${res.status}`, e?.message ?? res.statusText);
  }
  return data as T;
}

const enc = encodeURIComponent;

export const api: BeeApi = {
  shareToken: null,

  me: () =>
    req<MeResponse>('GET', '/auth/me').catch((e) => {
      if (e instanceof HttpError && e.status === 401) return null;
      throw e;
    }),
  login: (email, password) => req('POST', '/auth/login', { email, password }),
  register: (name, email, password) => req('POST', '/auth/register', { name, email, password }),
  logout: async () => {
    await req('POST', '/auth/logout');
  },

  tree: (ws) => req('GET', `/workspaces/${ws}/tree`),
  search: async (ws, q) => (await req<SearchResponse>('GET', `/workspaces/${ws}/search?q=${enc(q)}`)).results,
  trash: (ws) => req('GET', `/workspaces/${ws}/trash`),
  recent: async (ws) => (await req<RecentResponse>('GET', `/workspaces/${ws}/recent`)).documents,
  sharedWithMe: async () => (await req<RecentResponse>('GET', '/shared-with-me')).documents,

  createFolder: async (input) => (await req<FolderResponse>('POST', '/folders', input)).folder,
  updateFolder: async (id, patch) => (await req<FolderResponse>('PATCH', `/folders/${id}`, patch)).folder,
  deleteFolder: async (id) => {
    await req('DELETE', `/folders/${id}`);
  },
  restoreFolder: async (id) => {
    await req('POST', `/folders/${id}/restore`);
  },

  createDocument: async (input) => (await req<DocumentResponse>('POST', '/documents', input)).document,
  getDocument: async (id) => (await req<DocumentResponse>('GET', `/documents/${id}`)).document,
  updateDocument: async (id, patch) => (await req<DocumentResponse>('PATCH', `/documents/${id}`, patch)).document,
  deleteDocument: async (id) => {
    await req('DELETE', `/documents/${id}`);
  },
  restoreDocument: async (id) => (await req<DocumentResponse>('POST', `/documents/${id}/restore`)).document,
  upload: (id, file) => {
    const fd = new FormData();
    fd.append('file', file);
    return req('POST', `/documents/${id}/uploads`, fd);
  },
  blockExists: async (id, blockId) =>
    (await req<BlockLinkResponse>('GET', `/documents/${id}/blocks/${enc(blockId)}`)).exists,

  versions: async (id) => (await req<VersionsResponse>('GET', `/documents/${id}/versions`)).versions,
  createVersion: async (id, label) =>
    (await req<VersionResponse>('POST', `/documents/${id}/versions`, label ? { label } : {})).version,
  renameVersion: async (id, vid, label) =>
    (await req<VersionResponse>('PATCH', `/documents/${id}/versions/${vid}`, { label })).version,
  versionContent: (id, vid) => req('GET', `/documents/${id}/versions/${vid}`),
  restoreVersion: async (id, vid) => {
    await req('POST', `/documents/${id}/versions/${vid}/restore`);
  },

  threads: async (id) => (await req<ThreadsResponse>('GET', `/documents/${id}/threads`)).threads,
  createThread: async (id, anchor, body) =>
    (await req<ThreadResponse>('POST', `/documents/${id}/threads`, { anchor, body })).thread,
  reply: async (tid, body) => {
    await req('POST', `/threads/${tid}/comments`, { body });
  },
  setResolved: async (tid, resolved) => (await req<ThreadResponse>('PATCH', `/threads/${tid}`, { resolved })).thread,

  sharing: (id) => req('GET', `/documents/${id}/sharing`),
  addGrant: async (id, email, role) => {
    await req('POST', `/documents/${id}/grants`, { email, role });
  },
  updateGrant: async (gid, role) => {
    await req('PATCH', `/grants/${gid}`, { role });
  },
  removeGrant: async (gid) => {
    await req('DELETE', `/grants/${gid}`);
  },
  createLink: async (id, role, isPublic) =>
    (await req<LinkResponse>('POST', `/documents/${id}/links`, { role, public: isPublic })).link,
  updateLink: async (lid, patch) => (await req<LinkResponse>('PATCH', `/links/${lid}`, patch)).link,
  deleteLink: async (lid) => {
    await req('DELETE', `/links/${lid}`);
  },
  resolveShare: (token) => req('GET', `/share/${enc(token)}`),

  activity: async (id) => (await req<ActivityResponse>('GET', `/documents/${id}/activity`)).items,
};
