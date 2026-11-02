export type Role = 'owner' | 'editor' | 'commenter' | 'viewer';

export interface AuthResult {
  userId: string | null;
  role: Role;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Client for the api's /api/internal/collab/* endpoints. The only way collab talks to business logic. */
export class ApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
  ) {}

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('x-collab-secret', this.secret);
    const res = await fetch(`${this.baseUrl}/api/internal/collab${path}`, { ...init, headers });
    if (!res.ok && res.status !== 204) {
      const body = await res.text().catch(() => '');
      throw new ApiError(res.status, `${init.method ?? 'GET'} ${path} -> ${res.status} ${body.slice(0, 200)}`);
    }
    return res;
  }

  async authenticate(input: { documentId: string; cookie?: string; shareToken?: string }): Promise<AuthResult> {
    const res = await this.request('/auth', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const body = (await res.json()) as { userId?: string | null; user?: { id: string } | null; role: Role };
    return { userId: body.userId ?? body.user?.id ?? null, role: body.role };
  }

  /** Returns the stored Yjs update, or null when the document has no state yet. */
  async loadState(documentId: string): Promise<Uint8Array | null> {
    const res = await this.request(`/documents/${encodeURIComponent(documentId)}/state`);
    if (res.status === 204) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.byteLength > 0 ? buf : null;
  }

  async storeState(documentId: string, state: Uint8Array): Promise<void> {
    await this.request(`/documents/${encodeURIComponent(documentId)}/state`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: state,
    });
  }

  async storeMarkdown(documentId: string, markdown: string): Promise<void> {
    await this.request(`/documents/${encodeURIComponent(documentId)}/markdown`, {
      method: 'PUT',
      headers: { 'content-type': 'text/markdown; charset=utf-8' },
      body: markdown,
    });
  }

  async createVersion(documentId: string, snapshot: Uint8Array, authorIds: string[]): Promise<void> {
    await this.request(`/documents/${encodeURIComponent(documentId)}/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-author-ids': authorIds.join(',') },
      body: snapshot,
    });
  }
}
