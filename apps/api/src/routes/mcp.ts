import type { FastifyInstance, FastifyReply, FastifyRequest, InjectOptions } from 'fastify';
import { z } from 'zod';
import type {
  CommentThreadDTO,
  DocumentDTO,
  FolderDTO,
  MarkdownEditResponse,
  WorkspaceDTO,
} from '@bee/shared';
import { CollabClient } from '../lib/collab.js';

/**
 * MCP server (Streamable HTTP transport, stateless, JSON responses only) so Claude and other
 * MCP clients can work with Bee as the signed-in user. Authentication is a bearer token: a
 * personal API token, or an OAuth access token from /oauth/token.
 *
 * Every tool calls the regular /api routes in-process with the caller's token, so permissions,
 * validation and activity logging are exactly those of the web app, and content edits go
 * through the collab server like any other live edit.
 */

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'bee', title: 'Bee', version: '0.1.0' };

export const INSTRUCTIONS = `Bee is a collaborative document editor (folders, Markdown documents, comments).
- Start with list_documents (or search_documents) to find ids; most tools take a documentId or folderId.
- read_document returns the live content as Markdown. Prefer edit_document with mode "str_replace" for targeted edits: "find" must match the Markdown exactly once (copy it from read_document). Use "append" to add at the end, "replace" to rewrite everything. Edits show up live for people who have the document open; unchanged paragraphs keep their comments.
- add_comment with a "quote" pins the comment to that text; without it the comment is about the whole document.
- Diagrams: draw_diagram draws boxes with text and connecting arrows on a whiteboard (laid out automatically), on an existing board, a new one, or a new board embedded at the end of a document. read_whiteboard describes a board. For a quick diagram inside a document, a \`\`\`mermaid code block via edit_document also renders.
- Math: LaTeX between $…$ (inline) or $$…$$ on lines of their own (block) renders as formulas; write a literal dollar as \\$.
- Spreadsheets in a document appear as \`<!-- bee:sheet <id> name="…" -->\` followed by a table of their computed values. Keep the marker line when editing around them; the values table is read-only (changes to it are ignored).
- Whiteboards cannot be read or edited as Markdown.`;

export class ToolError extends Error {}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export type Ctx = {
  userId: string;
  call: <T>(method: InjectOptions['method'], url: string, payload?: unknown) => Promise<T>;
  collab: CollabClient;
  publicUrl: string;
};

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string;
  title: string;
  description: string;
  input: S;
  readOnly?: boolean;
  destructive?: boolean;
  run: (args: z.infer<S>, ctx: Ctx) => Promise<string>;
}

const tool = <S extends z.ZodType>(t: Tool<S>) => t as unknown as Tool;

const id = z.uuid();
const docUrl = (ctx: Ctx, docId: string) => `${ctx.publicUrl}/d/${docId}`;
const json = (v: unknown) => JSON.stringify(v, null, 2);

async function defaultWorkspace(ctx: Ctx, workspaceId?: string): Promise<string> {
  if (workspaceId) return workspaceId;
  const { workspaces } = await ctx.call<{ workspaces: WorkspaceDTO[] }>('GET', '/api/workspaces');
  if (!workspaces[0]) throw new ToolError('You are not a member of any workspace');
  return workspaces[0].id;
}

const docLine = (d: DocumentDTO) =>
  `${d.type === 'whiteboard' ? '[whiteboard]' : '[doc]'} ${d.title || 'Untitled'} (id: ${d.id}, role: ${d.role}, updated ${d.updatedAt})`;

function renderTree(folders: FolderDTO[], docs: DocumentDTO[], rootId: string | null): string {
  const lines: string[] = [];
  const walk = (parentId: string | null, depth: number) => {
    const pad = '  '.repeat(depth);
    for (const f of folders.filter((x) => x.parentId === parentId)) {
      lines.push(`${pad}- [folder] ${f.name} (id: ${f.id}, role: ${f.role})`);
      walk(f.id, depth + 1);
    }
    for (const d of docs.filter((x) => x.folderId === parentId))
      lines.push(`${pad}- ${docLine(d)}`);
  };
  walk(rootId, 0);
  return lines.join('\n') || '(empty)';
}

const commentsText = (threads: CommentThreadDTO[]) =>
  threads.length
    ? threads
        .map((t) => {
          const head = `Thread ${t.id}${t.resolved ? ' (resolved)' : ''}${t.anchor ? ` on "${t.anchor.quote}"` : ' (whole document)'}`;
          const body = t.comments
            .map(
              (c) => `  - ${c.author.name}${c.guest ? ' (guest)' : ''}, ${c.createdAt}: ${c.body}`,
            )
            .join('\n');
          return `${head}\n${body}`;
        })
        .join('\n\n')
    : 'No comments.';

export const TOOLS: Tool[] = [
  tool({
    name: 'list_workspaces',
    title: 'List workspaces',
    description:
      'Lists the workspaces you belong to (your personal one and teams), and who you are signed in as.',
    input: z.object({}),
    readOnly: true,
    run: async (_a, ctx) => {
      const me = await ctx.call<{
        user: { name: string; email: string };
        workspaces: WorkspaceDTO[];
      }>('GET', '/api/auth/me');
      return json({
        user: { name: me.user.name, email: me.user.email },
        workspaces: me.workspaces.map((w) => ({
          id: w.id,
          name: w.name,
          kind: w.kind,
          role: w.role,
          members: w.memberCount,
        })),
      });
    },
  }),
  tool({
    name: 'list_documents',
    title: 'List folders and documents',
    description:
      'Shows the folder tree with documents you can read, with their ids. Defaults to your first workspace; pass folderId to show only that folder.',
    input: z.object({
      workspaceId: id.optional().describe('Workspace id (default: your first workspace)'),
      folderId: id.optional().describe('Only show the contents of this folder'),
    }),
    readOnly: true,
    run: async (a, ctx) => {
      let workspaceId = a.workspaceId;
      if (a.folderId && !workspaceId) {
        const { folder } = await ctx.call<{ folder: FolderDTO }>(
          'GET',
          `/api/folders/${a.folderId}`,
        );
        workspaceId = folder.workspaceId;
      }
      const ws = await defaultWorkspace(ctx, workspaceId);
      const tree = await ctx.call<{ folders: FolderDTO[]; documents: DocumentDTO[] }>(
        'GET',
        `/api/workspaces/${ws}/tree`,
      );
      return `Workspace ${ws}${a.folderId ? `, folder ${a.folderId}` : ''}:\n${renderTree(tree.folders, tree.documents, a.folderId ?? null)}`;
    },
  }),
  tool({
    name: 'list_shared_with_me',
    title: 'List documents shared with me',
    description:
      'Lists documents other people shared with you directly, including from workspaces you are not in.',
    input: z.object({}),
    readOnly: true,
    run: async (_a, ctx) => {
      const { documents } = await ctx.call<{ documents: DocumentDTO[] }>(
        'GET',
        '/api/shared-with-me',
      );
      return documents.length
        ? documents.map((d) => `- ${docLine(d)}`).join('\n')
        : 'Nothing is shared with you.';
    },
  }),
  tool({
    name: 'search_documents',
    title: 'Search documents',
    description:
      'Full-text search over titles and content of the documents you can read in a workspace.',
    input: z.object({
      query: z.string().min(1).max(200),
      workspaceId: id.optional().describe('Workspace id (default: your first workspace)'),
    }),
    readOnly: true,
    run: async (a, ctx) => {
      const ws = await defaultWorkspace(ctx, a.workspaceId);
      const { results } = await ctx.call<{ results: { document: DocumentDTO; snippet: string }[] }>(
        'GET',
        `/api/workspaces/${ws}/search?q=${encodeURIComponent(a.query)}`,
      );
      return results.length
        ? results.map((r) => `- ${docLine(r.document)}\n  ${r.snippet}`).join('\n')
        : 'No matches.';
    },
  }),
  tool({
    name: 'read_document',
    title: 'Read a document',
    description:
      'Returns a document as Markdown (live content, including unsaved edits of people who have it open), with its title, folder and your role.',
    input: z.object({
      documentId: id,
      includeComments: z.boolean().optional().describe('Also list the open comment threads'),
    }),
    readOnly: true,
    run: async (a, ctx) => {
      const { document: d } = await ctx.call<{ document: DocumentDTO }>(
        'GET',
        `/api/documents/${a.documentId}`,
      );
      const head = [
        `Title: ${d.title || 'Untitled'}`,
        `Id: ${d.id}`,
        `Type: ${d.type}`,
        `Folder: ${d.folderId ?? '(workspace root)'}`,
        `Your role: ${d.role}`,
        `Last edited: ${d.updatedAt}${d.lastEditedBy ? ` by ${d.lastEditedBy.name}` : ''}`,
        `URL: ${docUrl(ctx, d.id)}`,
      ].join('\n');
      if (d.type !== 'doc') return `${head}\n\n(This ${d.type} has no Markdown content.)`;
      const { markdown } = await ctx.call<{ markdown: string }>(
        'GET',
        `/api/documents/${d.id}/markdown`,
      );
      let out = `${head}\n\n---\n\n${markdown}`;
      if (a.includeComments) {
        const { threads } = await ctx.call<{ threads: CommentThreadDTO[] }>(
          'GET',
          `/api/documents/${d.id}/threads?resolved=0`,
        );
        out += `\n\n---\n\nOpen comments:\n${commentsText(threads)}`;
      }
      return out;
    },
  }),
  tool({
    name: 'create_document',
    title: 'Create a document',
    description:
      'Creates a document from Markdown. Defaults to the root of your first workspace. Without a title, a leading "# Heading" becomes the title (Bee shows the title above the body).',
    input: z.object({
      title: z.string().max(500).optional(),
      markdown: z.string().max(5_000_000).optional().describe('Initial content'),
      folderId: id.optional().describe('Folder to create it in (default: workspace root)'),
      workspaceId: id
        .optional()
        .describe('Workspace id (default: the folder’s, or your first workspace)'),
    }),
    run: async (a, ctx) => {
      let ws = a.workspaceId;
      if (!ws && a.folderId) {
        const { folder } = await ctx.call<{ folder: FolderDTO }>(
          'GET',
          `/api/folders/${a.folderId}`,
        );
        ws = folder.workspaceId;
      }
      ws = await defaultWorkspace(ctx, ws);
      // Bee shows the title above the body, so a leading "# Title" becomes the title only.
      let markdown = a.markdown ?? '';
      let title = a.title;
      const h1 = /^\s*# (.+)\n*/.exec(markdown);
      if (h1 && (title === undefined || title.trim() === h1[1]!.trim())) {
        title = h1[1]!.trim();
        markdown = markdown.slice(h1[0].length);
      }
      const { document: d } = await ctx.call<{ document: DocumentDTO }>('POST', '/api/documents', {
        workspaceId: ws,
        folderId: a.folderId ?? null,
        title,
        markdown,
      });
      return `Created "${d.title || 'Untitled'}" (id: ${d.id})\nURL: ${docUrl(ctx, d.id)}`;
    },
  }),
  tool({
    name: 'edit_document',
    title: 'Edit a document',
    description:
      'Edits a document\'s content as Markdown, live (people who have it open see the change). Modes: "str_replace" replaces the exact text `find` (must occur once in the Markdown from read_document, unless replaceAll) with `replace`; "append" adds `markdown` at the end; "replace" makes the whole document equal to `markdown`. Unchanged paragraphs keep their comments and links.',
    input: z.object({
      documentId: id,
      mode: z.enum(['str_replace', 'append', 'replace']),
      find: z.string().optional().describe('str_replace: exact Markdown to find'),
      replace: z.string().optional().describe('str_replace: replacement Markdown (may be empty)'),
      replaceAll: z.boolean().optional().describe('str_replace: replace every occurrence'),
      markdown: z.string().max(5_000_000).optional().describe('append / replace: the Markdown'),
    }),
    run: async (a, ctx) => {
      let body: unknown;
      if (a.mode === 'str_replace') {
        if (!a.find) throw new ToolError('`find` is required for str_replace');
        body = { mode: a.mode, find: a.find, replace: a.replace ?? '', replaceAll: a.replaceAll };
      } else {
        if (a.markdown === undefined) throw new ToolError(`\`markdown\` is required for ${a.mode}`);
        body = { mode: a.mode, markdown: a.markdown };
      }
      const r = await ctx.call<MarkdownEditResponse>(
        'POST',
        `/api/documents/${a.documentId}/markdown`,
        body,
      );
      const stats = `${r.inserted} block(s) added, ${r.removed} removed, ${r.kept} unchanged${r.occurrences ? `; ${r.occurrences} occurrence(s) replaced` : ''}`;
      return `Edited "${r.title || 'Untitled'}": ${stats}.\nURL: ${docUrl(ctx, a.documentId)}`;
    },
  }),
  tool({
    name: 'update_document',
    title: 'Rename or move a document',
    description:
      'Renames a document and/or moves it to another folder (folderId null = workspace root). Moving needs owner access.',
    input: z.object({
      documentId: id,
      title: z.string().max(500).optional(),
      folderId: id.nullable().optional(),
    }),
    run: async (a, ctx) => {
      const patch: Record<string, unknown> = {};
      if (a.title !== undefined) patch.title = a.title;
      if (a.folderId !== undefined) patch.folderId = a.folderId;
      const { document: d } = await ctx.call<{ document: DocumentDTO }>(
        'PATCH',
        `/api/documents/${a.documentId}`,
        patch,
      );
      return `Updated: "${d.title || 'Untitled'}" in ${d.folderId ? `folder ${d.folderId}` : 'the workspace root'}.`;
    },
  }),
  tool({
    name: 'trash_document',
    title: 'Move a document to the trash',
    description:
      'Moves a document to the trash (it can be restored from the trash in Bee). Owner only.',
    input: z.object({ documentId: id }),
    destructive: true,
    run: async (a, ctx) => {
      await ctx.call('DELETE', `/api/documents/${a.documentId}`);
      return 'Moved to the trash.';
    },
  }),
  tool({
    name: 'create_folder',
    title: 'Create a folder',
    description: 'Creates a folder at the workspace root or inside parentId.',
    input: z.object({
      name: z.string().min(1).max(200),
      parentId: id.optional(),
      workspaceId: id
        .optional()
        .describe('Workspace id (default: the parent’s, or your first workspace)'),
    }),
    run: async (a, ctx) => {
      let ws = a.workspaceId;
      if (!ws && a.parentId) {
        const { folder } = await ctx.call<{ folder: FolderDTO }>(
          'GET',
          `/api/folders/${a.parentId}`,
        );
        ws = folder.workspaceId;
      }
      ws = await defaultWorkspace(ctx, ws);
      const { folder } = await ctx.call<{ folder: FolderDTO }>('POST', '/api/folders', {
        workspaceId: ws,
        parentId: a.parentId ?? null,
        name: a.name,
      });
      return `Created folder "${folder.name}" (id: ${folder.id}).`;
    },
  }),
  tool({
    name: 'update_folder',
    title: 'Rename or move a folder',
    description:
      'Renames a folder and/or moves it under another folder (parentId null = workspace root).',
    input: z.object({
      folderId: id,
      name: z.string().min(1).max(200).optional(),
      parentId: id.nullable().optional(),
    }),
    run: async (a, ctx) => {
      const patch: Record<string, unknown> = {};
      if (a.name !== undefined) patch.name = a.name;
      if (a.parentId !== undefined) patch.parentId = a.parentId;
      const { folder } = await ctx.call<{ folder: FolderDTO }>(
        'PATCH',
        `/api/folders/${a.folderId}`,
        patch,
      );
      return `Updated folder "${folder.name}".`;
    },
  }),
  tool({
    name: 'read_whiteboard',
    title: 'Read a whiteboard',
    description:
      'Describes a whiteboard: its shapes with their text, positions and fills, the arrows between them, and free text.',
    input: z.object({ documentId: id }),
    readOnly: true,
    run: async (a, ctx) => {
      const r = await ctx.call<{ title: string; description: string }>(
        'GET',
        `/api/documents/${a.documentId}/whiteboard`,
      );
      return `Whiteboard: ${r.title || 'Untitled'}\nURL: ${docUrl(ctx, a.documentId)}\n\n${r.description}`;
    },
  }),
  tool({
    name: 'draw_diagram',
    title: 'Draw a diagram on a whiteboard',
    description:
      'Draws a diagram (flowchart, architecture, mind map...) on a whiteboard: each node becomes a shape with its label inside, each edge an arrow bound to both shapes, laid out automatically in layers (direction "down" or "right"). Targets: `documentId` of an existing whiteboard (mode "append" draws below what is there, "replace" clears it first); or omit it to create a new whiteboard (in `folderId`, or embedded at the end of the document `embedInDocumentId`). People who have the board open see it appear live.',
    input: z.object({
      documentId: id.optional().describe('Existing whiteboard to draw on'),
      mode: z
        .enum(['append', 'replace'])
        .optional()
        .describe('For an existing board (default append)'),
      title: z.string().max(500).optional().describe('Title of a new whiteboard'),
      folderId: id.optional().describe('Folder for a new whiteboard (default: workspace root)'),
      workspaceId: id.optional(),
      embedInDocumentId: id
        .optional()
        .describe('Create the board inside this document, appended at its end'),
      direction: z.enum(['down', 'right']).optional().describe('Layout direction (default down)'),
      arrows: z
        .enum(['elbow', 'straight'])
        .optional()
        .describe(
          'Connector style: straight = direct lines (default); elbow = right-angle lines routed between the shapes, like draw.io',
        ),
      nodes: z
        .array(
          z.object({
            id: z.string().min(1).max(100).describe('Your id, used by edges'),
            label: z.string().max(2000).describe('Text inside the shape; \\n for line breaks'),
            shape: z.enum(['rectangle', 'ellipse', 'diamond']).optional(),
            color: z
              .string()
              .max(32)
              .optional()
              .describe(
                'Fill: blue, green, yellow, orange, red, pink, violet, grape, cyan, teal, gray, or #rrggbb',
              ),
            x: z.number().optional().describe('Optional manual position (overrides the layout)'),
            y: z.number().optional(),
          }),
        )
        .min(1)
        .max(300),
      edges: z
        .array(
          z.object({
            from: z.string(),
            to: z.string(),
            label: z.string().max(500).optional(),
            dashed: z.boolean().optional(),
          }),
        )
        .max(1000)
        .optional(),
    }),
    run: async (a, ctx) => {
      let boardId = a.documentId;
      let created = '';
      if (!boardId) {
        const create: Record<string, unknown> = { type: 'whiteboard', title: a.title ?? '' };
        if (a.embedInDocumentId) create.parentDocumentId = a.embedInDocumentId;
        else {
          let ws = a.workspaceId;
          if (!ws && a.folderId) {
            const { folder } = await ctx.call<{ folder: FolderDTO }>(
              'GET',
              `/api/folders/${a.folderId}`,
            );
            ws = folder.workspaceId;
          }
          create.workspaceId = await defaultWorkspace(ctx, ws);
          create.folderId = a.folderId ?? null;
        }
        const { document: d } = await ctx.call<{ document: DocumentDTO }>(
          'POST',
          '/api/documents',
          create,
        );
        boardId = d.id;
        created = `Created whiteboard ${d.id}`;
      }
      const r = await ctx.call<{ shapes: number; arrows: number; removed: number }>(
        'POST',
        `/api/documents/${boardId}/diagram`,
        { nodes: a.nodes, edges: a.edges, direction: a.direction, arrows: a.arrows, mode: a.mode },
      );
      if (!a.documentId && a.embedInDocumentId) {
        // Creating the board needed edit access on the parent, so the embed is allowed too.
        await ctx.collab.appendBlocks(
          a.embedInDocumentId,
          [{ type: 'whiteboard', attrs: { documentId: boardId, height: 480 } }],
          ctx.userId,
        );
        created += ` and embedded it at the end of document ${a.embedInDocumentId}`;
      }
      const url = docUrl(ctx, a.embedInDocumentId && !a.documentId ? a.embedInDocumentId : boardId);
      return `${created ? created + '. ' : ''}Drew ${r.shapes} shape(s) and ${r.arrows} arrow(s)${r.removed ? ` after clearing ${r.removed} element(s)` : ''} on whiteboard ${boardId}.\nURL: ${url}`;
    },
  }),
  tool({
    name: 'list_comments',
    title: 'List comments',
    description: 'Lists the comment threads on a document with their replies.',
    input: z.object({
      documentId: id,
      includeResolved: z.boolean().optional(),
    }),
    readOnly: true,
    run: async (a, ctx) => {
      const { threads } = await ctx.call<{ threads: CommentThreadDTO[] }>(
        'GET',
        `/api/documents/${a.documentId}/threads${a.includeResolved ? '' : '?resolved=0'}`,
      );
      return commentsText(threads);
    },
  }),
  tool({
    name: 'add_comment',
    title: 'Comment on a document',
    description:
      'Starts a comment thread. With `quote` (exact text from one paragraph or list item, as shown to readers, without Markdown syntax) the comment is pinned to that text; otherwise it is about the whole document.',
    input: z.object({
      documentId: id,
      body: z.string().min(1).max(20_000),
      quote: z.string().max(2000).optional(),
      occurrence: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Which match of `quote` to pin to (default 1)'),
    }),
    run: async (a, ctx) => {
      // Read access first, so anchoring never reveals anything about documents you cannot read.
      await ctx.call('GET', `/api/documents/${a.documentId}`);
      const anchor = a.quote
        ? await ctx.collab.anchorFor(a.documentId, a.quote, a.occurrence)
        : null;
      const { thread } = await ctx.call<{ thread: CommentThreadDTO }>(
        'POST',
        `/api/documents/${a.documentId}/threads`,
        { anchor, body: a.body },
      );
      return `Comment added (thread ${thread.id})${anchor ? ` on "${anchor.quote}"` : ''}.`;
    },
  }),
  tool({
    name: 'reply_to_comment',
    title: 'Reply to a comment thread',
    description: 'Adds a reply to a comment thread (reopens it if it was resolved).',
    input: z.object({ threadId: id, body: z.string().min(1).max(20_000) }),
    run: async (a, ctx) => {
      await ctx.call('POST', `/api/threads/${a.threadId}/comments`, { body: a.body });
      return 'Reply added.';
    },
  }),
  tool({
    name: 'resolve_comment',
    title: 'Resolve or reopen a comment thread',
    description: 'Marks a comment thread resolved (or reopens it with resolved: false).',
    input: z.object({ threadId: id, resolved: z.boolean().default(true) }),
    run: async (a, ctx) => {
      await ctx.call('PATCH', `/api/threads/${a.threadId}`, { resolved: a.resolved });
      return a.resolved ? 'Thread resolved.' : 'Thread reopened.';
    },
  }),
];

const toolList = TOOLS.map((t) => {
  const { $schema: _ignored, ...inputSchema } = z.toJSONSchema(t.input, { io: 'input' }) as Record<
    string,
    unknown
  >;
  return {
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema,
    annotations: {
      title: t.title,
      readOnlyHint: !!t.readOnly,
      destructiveHint: !!t.destructive,
      openWorldHint: false,
    },
  };
});

/**
 * Calls the regular /api routes in-process with the given credentials (a bearer token, or
 * the session cookie for Ask AI), turning error responses into ToolErrors.
 */
export function injectCaller(app: FastifyInstance, auth: Record<string, string>): Ctx['call'] {
  return async <T>(method: InjectOptions['method'], url: string, payload?: unknown) => {
    const res = await app.inject({
      method,
      url,
      headers: {
        ...auth,
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });
    const body = res.body
      ? (JSON.parse(res.body) as T & { error?: { message?: string } })
      : ({} as T);
    if (res.statusCode >= 400) {
      const message =
        (body as { error?: { message?: string } }).error?.message ?? `HTTP ${res.statusCode}`;
      throw new ToolError(
        res.statusCode === 404 ? `${message} (or you do not have access)` : message,
      );
    }
    return body;
  };
}

const rpcError = (id: JsonRpcRequest['id'], code: number, message: string) => ({
  jsonrpc: '2.0' as const,
  id: id ?? null,
  error: { code, message },
});

export async function mcpRoutes(app: FastifyInstance) {
  const collab = new CollabClient(app.config);
  const publicUrl = app.config.publicUrl;
  const resourceMetadata = `${publicUrl}/.well-known/oauth-protected-resource/mcp`;

  const unauthorized = (reply: FastifyReply) =>
    reply
      .status(401)
      .header('www-authenticate', `Bearer realm="bee", resource_metadata="${resourceMetadata}"`)
      .send(rpcError(null, -32001, 'Authentication required'));

  async function handle(req: FastifyRequest, msg: JsonRpcRequest) {
    const ctx: Ctx = {
      userId: req.user!.id,
      collab,
      publicUrl,
      call: injectCaller(app, { authorization: req.headers.authorization! }),
    };
    switch (msg.method) {
      case 'initialize': {
        const requested = String(msg.params?.protocolVersion ?? '');
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: toolList };
      case 'tools/call': {
        const t = TOOLS.find((x) => x.name === msg.params?.name);
        if (!t)
          throw Object.assign(new Error(`Unknown tool: ${String(msg.params?.name)}`), {
            rpcCode: -32602,
          });
        const parsed = t.input.safeParse(msg.params?.arguments ?? {});
        if (!parsed.success)
          return {
            content: [
              { type: 'text', text: `Invalid arguments: ${z.prettifyError(parsed.error)}` },
            ],
            isError: true,
          };
        try {
          return { content: [{ type: 'text', text: await t.run(parsed.data, ctx) }] };
        } catch (err) {
          if (err instanceof ToolError || (err as { status?: number }).status)
            return { content: [{ type: 'text', text: (err as Error).message }], isError: true };
          req.log.error({ err, tool: t.name }, 'mcp tool failed');
          return { content: [{ type: 'text', text: 'Internal error' }], isError: true };
        }
      }
      case 'resources/list':
        return { resources: [] };
      case 'prompts/list':
        return { prompts: [] };
      default:
        throw Object.assign(new Error(`Method not found: ${msg.method}`), { rpcCode: -32601 });
    }
  }

  const respond = async (req: FastifyRequest, msg: JsonRpcRequest) => {
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string')
      return rpcError(msg?.id, -32600, 'Invalid request');
    // Notifications (no id) get no response.
    if (msg.id === undefined || msg.id === null) return null;
    try {
      return { jsonrpc: '2.0' as const, id: msg.id, result: await handle(req, msg) };
    } catch (err) {
      const e = err as Error & { rpcCode?: number };
      return rpcError(msg.id, e.rpcCode ?? -32603, e.message);
    }
  };

  app.post(
    '/mcp',
    { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } },
    async (req, reply) => {
      if (!req.user || req.authKind !== 'token') return unauthorized(reply);
      const body = req.body as JsonRpcRequest | JsonRpcRequest[] | undefined;
      if (!body || typeof body !== 'object')
        return reply.status(400).send(rpcError(null, -32700, 'Parse error'));
      if (Array.isArray(body)) {
        const out = (await Promise.all(body.map((m) => respond(req, m)))).filter(Boolean);
        return out.length ? reply.send(out) : reply.status(202).send();
      }
      const out = await respond(req, body);
      return out ? reply.send(out) : reply.status(202).send();
    },
  );

  // No server-initiated stream and no sessions in this stateless server.
  const notAllowed = async (_req: FastifyRequest, reply: FastifyReply) =>
    reply
      .status(405)
      .header('allow', 'POST')
      .send(rpcError(null, -32000, 'Method not allowed'));
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
}
