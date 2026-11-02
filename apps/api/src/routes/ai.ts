import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { aiSettings } from '@bee/db';
import {
  AI_PROVIDERS,
  type AiModelsResponse,
  type AiProvider,
  type AiSettingsDTO,
  type AiStreamEvent,
  type DocumentDTO,
} from '@bee/shared';
import { randomToken } from '../lib/auth.js';
import { CollabClient } from '../lib/collab.js';
import { badRequest, forbidden, HttpError } from '../lib/errors.js';
import { openKeys, sealKeys, type KeyRing } from '../lib/ai/keys.js';
import { listModels, openSession, type ToolOutput, type ToolSpec } from '../lib/ai/providers.js';
import { parse } from '../lib/validate.js';
import { requireUser } from './auth.js';
import { INSTRUCTIONS, TOOLS, ToolError, injectCaller, type Ctx } from './mcp.js';

/**
 * Ask AI: a chat next to the document that writes and edits documents with the user's own
 * AI account. The model gets the MCP server's tools (minus destructive ones), run in-process
 * with the user's session, so it can do exactly what the user can, and every edit goes
 * through the collab server like any live edit. Edits report the Markdown before and after,
 * so the chat can undo them.
 */

const MAX_STEPS = 20;
/** a model step that sends nothing for this long is abandoned */
const STALL_MS = 120_000;
const MAX_TOOL_RESULT = 100_000;
const OAUTH_COOKIE = 'bee_ai_oauth';

const AI_TOOLS = TOOLS.filter((t) => !t.destructive);
const TOOL_SPECS: ToolSpec[] = AI_TOOLS.map((t) => {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(t.input, { io: 'input' }) as Record<
    string,
    unknown
  >;
  return { name: t.name, description: t.description, schema };
});

const providerSchema = z.enum(AI_PROVIDERS);

function requireSessionUser(req: FastifyRequest) {
  const user = requireUser(req);
  if (req.authKind !== 'session') throw forbidden('Ask AI is available in the Bee web app');
  return user;
}

const systemPrompt = (name: string, doc: DocumentDTO | null, publicUrl: string) => `You are Ask AI, the assistant built into Bee. You help ${name} write, create and edit documents, using the tools with their permissions.

${INSTRUCTIONS}

How to work:
- Read a document before you edit it. Make targeted edits with edit_document "str_replace"; rewrite the whole document with "replace" only when the user asks for a rewrite. Keep the existing style and structure unless asked to change them.
- Edits show up live for everyone who has the document open, and the user can undo your edits from this chat, so make the change instead of asking for permission first. Ask only when the request is genuinely ambiguous.
- To create a document, use create_document with the content as Markdown${doc?.folderId ? ', in the same folder as the open document unless the user says otherwise' : ''}.
- For diagrams, use draw_diagram on a whiteboard.
- After you change something, say in a sentence or two what you changed. Do not paste the document back into the chat unless asked.
- Reply in the language the user writes in. Format replies as Markdown. Link documents as ${publicUrl}/d/<id>.
${
  doc
    ? `\nThe user has this document open (when they say "this document", they mean it):\nTitle: ${doc.title || 'Untitled'}\nId: ${doc.id}\nType: ${doc.type}\nFolder: ${doc.folderId ?? '(workspace root)'}\nTheir role: ${doc.role}${doc.type === 'doc' && !['owner', 'editor'].includes(doc.role) ? ' (they cannot edit it; you can still read it and create new documents)' : ''}`
    : '\nThe user has no document open.'
}`;

export async function aiRoutes(app: FastifyInstance) {
  const { db, config } = app;
  const collab = new CollabClient(config);
  const callbackUrl = `${config.publicUrl}/api/ai/openrouter/callback`;

  async function load(userId: string) {
    const [row] = await db.select().from(aiSettings).where(eq(aiSettings.userId, userId));
    return row ? { ...row, ring: openKeys(config.aiKeysSecret, row.keys) } : null;
  }
  const dto = (row: Awaited<ReturnType<typeof load>>): AiSettingsDTO => {
    const connected = AI_PROVIDERS.filter((p) => row?.ring[p]);
    const provider = row && connected.includes(row.provider as AiProvider) ? (row.provider as AiProvider) : (connected[0] ?? null);
    return { provider, model: provider === row?.provider ? (row?.model ?? null) : null, connected };
  };
  async function save(userId: string, provider: AiProvider, model: string | null, ring: KeyRing) {
    const values = { provider, model, keys: sealKeys(config.aiKeysSecret, ring), updatedAt: new Date() };
    await db
      .insert(aiSettings)
      .values({ userId, ...values })
      .onConflictDoUpdate({ target: aiSettings.userId, set: values });
  }
  /** Stores a key and makes its provider the active one, with its default model. */
  async function connect(userId: string, provider: AiProvider, apiKey: string) {
    const models = await listModels(provider, apiKey, config.publicUrl);
    const row = await load(userId);
    await save(userId, provider, models[0]?.id ?? null, { ...row?.ring, [provider]: apiKey });
  }

  app.get('/ai/settings', async (req) => dto(await load(requireSessionUser(req).id)));

  app.put('/ai/settings', async (req) => {
    const user = requireSessionUser(req);
    const body = parse(
      z.object({ provider: providerSchema.optional(), model: z.string().trim().min(1).max(200).optional() }),
      req.body,
    );
    const row = await load(user.id);
    const provider = body.provider ?? (dto(row).provider as AiProvider | null);
    if (!row || !provider || !row.ring[provider]) throw badRequest('Connect this AI account first', 'ai_not_connected');
    const model = body.model ?? (provider === row.provider ? row.model : null) ?? (await listModels(provider, row.ring[provider]!, config.publicUrl).then((m) => m[0]?.id ?? null, () => null));
    await save(user.id, provider, model, row.ring);
    return dto(await load(user.id));
  });

  app.get('/ai/models', async (req): Promise<AiModelsResponse> => {
    const user = requireSessionUser(req);
    const { provider } = parse(z.object({ provider: providerSchema }), req.query);
    const key = (await load(user.id))?.ring[provider];
    if (!key) throw badRequest('Connect this AI account first', 'ai_not_connected');
    try {
      return { models: await listModels(provider, key, config.publicUrl) };
    } catch (err) {
      req.log.warn({ err, provider }, 'ai model list failed');
      throw new HttpError(502, 'ai_provider_error', 'Could not load the models from the provider');
    }
  });

  /** Pasted API key for one provider; checked by listing its models. */
  app.put('/ai/keys/:provider', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const user = requireSessionUser(req);
    const { provider } = parse(z.object({ provider: providerSchema }), req.params);
    const { apiKey } = parse(z.object({ apiKey: z.string().trim().min(8).max(500) }), req.body);
    try {
      await connect(user.id, provider, apiKey);
    } catch (err) {
      req.log.info({ err, provider }, 'ai key rejected');
      throw badRequest('The provider did not accept this API key', 'ai_key_rejected');
    }
    return dto(await load(user.id));
  });

  app.delete('/ai/keys/:provider', async (req) => {
    const user = requireSessionUser(req);
    const { provider } = parse(z.object({ provider: providerSchema }), req.params);
    const row = await load(user.id);
    if (!row) return dto(null);
    const ring: KeyRing = { ...row.ring };
    delete ring[provider];
    const next = AI_PROVIDERS.find((p) => ring[p]);
    if (!next) await db.delete(aiSettings).where(eq(aiSettings.userId, user.id));
    else await save(user.id, provider === row.provider ? next : (row.provider as AiProvider), provider === row.provider ? null : row.model, ring);
    return dto(await load(user.id));
  });

  // ---------- Sign in with OpenRouter (OAuth PKCE; the result is a key the user owns) ----------

  app.get('/ai/openrouter/start', async (req, reply) => {
    requireSessionUser(req);
    const { next } = parse(z.object({ next: z.string().max(2000).optional() }), req.query);
    const verifier = randomToken(32);
    const state = randomToken(16);
    reply.setCookie(OAUTH_COOKIE, JSON.stringify({ verifier, state, next: safeNext(next) }), {
      path: '/api/ai/openrouter',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.publicUrl.startsWith('https://'),
      maxAge: 600,
      signed: true,
    });
    const url = new URL('https://openrouter.ai/auth');
    url.searchParams.set('callback_url', callbackUrl);
    url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('key_label', 'Bee');
    return reply.redirect(url.toString());
  });

  app.get('/ai/openrouter/callback', async (req, reply) => {
    const user = requireSessionUser(req);
    const q = req.query as { code?: string; state?: string };
    const raw = req.cookies[OAUTH_COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : null;
    reply.clearCookie(OAUTH_COOKIE, { path: '/api/ai/openrouter' });
    let saved: { verifier: string; state: string; next: string } | null = null;
    try {
      saved = unsigned?.valid && unsigned.value ? JSON.parse(unsigned.value) : null;
    } catch {
      saved = null;
    }
    const finish = (ok: boolean) => reply.type('text/html').send(callbackPage(ok, saved?.next ?? '/'));
    // OpenRouter does not return `state` on denial; no code means the user cancelled.
    if (!saved || !q.code || (q.state && q.state !== saved.state)) return finish(false);
    try {
      const res = await fetch('https://openrouter.ai/api/v1/auth/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: q.code, code_verifier: saved.verifier, code_challenge_method: 'S256' }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = (await res.json().catch(() => null)) as { key?: string } | null;
      if (!res.ok || !body?.key) throw new Error(`key exchange failed: ${res.status}`);
      await connect(user.id, 'openrouter', body.key);
      return finish(true);
    } catch (err) {
      req.log.warn({ err }, 'openrouter sign-in failed');
      return finish(false);
    }
  });

  // ---------- chat ----------

  app.post(
    '/ai/chat',
    { config: { rateLimit: { max: config.aiRateLimit, timeWindow: '1 minute', keyGenerator: (req) => req.user?.id ?? req.ip } } },
    async (req, reply) => {
      const user = requireSessionUser(req);
      const body = parse(
        z.object({
          messages: z
            .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(200_000) }))
            .min(1)
            .max(100),
          documentId: z.uuid().optional(),
        }),
        req.body,
      );
      if (body.messages.at(-1)!.role !== 'user') throw badRequest('The last message must be from the user');
      const row = await load(user.id);
      const settings = dto(row);
      const provider = settings.provider;
      const key = provider && row?.ring[provider];
      if (!provider || !key) throw badRequest('Connect an AI account first', 'ai_not_connected');
      const model = settings.model ?? (await listModels(provider, key, config.publicUrl).then((m) => m[0]?.id, () => undefined));
      if (!model) throw badRequest('Pick a model first', 'ai_no_model');

      const ctx: Ctx = {
        userId: user.id,
        collab,
        publicUrl: config.publicUrl,
        call: injectCaller(app, { cookie: req.headers.cookie ?? '' }),
      };
      const doc = body.documentId
        ? await ctx
            .call<{ document: DocumentDTO }>('GET', `/api/documents/${body.documentId}`)
            .then((r) => r.document, () => null)
        : null;

      const abort = new AbortController();
      req.raw.on('close', () => abort.abort());
      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'x-accel-buffering': 'no',
        // Keeps the proxy's gzip/zstd from buffering the stream.
        'content-encoding': 'identity',
        connection: 'keep-alive',
      });
      const send = (e: AiStreamEvent) => {
        if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
      };
      // Proxies (Cloudflare) drop streams that are silent for too long.
      const ping = setInterval(() => !reply.raw.writableEnded && reply.raw.write(': ping\n\n'), 15_000);

      try {
        const session = openSession(provider, key, config.publicUrl, {
          system: systemPrompt(user.name, doc, config.publicUrl),
          history: body.messages,
          tools: TOOL_SPECS,
          model,
        });
        req.log.info({ provider, model, doc: doc?.id }, 'ai chat start');
        for (let step = 0; ; step++) {
          const t0 = Date.now();
          // Abandon a step whose stream goes quiet, instead of spinning forever.
          const stall = new AbortController();
          let timer = setTimeout(() => stall.abort(), STALL_MS);
          let chunks = 0;
          let firstMs: number | null = null;
          const r = await session
            .step(
              (delta) => send({ type: 'text', delta }),
              AbortSignal.any([abort.signal, stall.signal]),
              () => {
                chunks++;
                firstMs ??= Date.now() - t0;
                clearTimeout(timer);
                timer = setTimeout(() => stall.abort(), STALL_MS);
              },
            )
            .catch((err: unknown) => {
              req.log.info({ step, ms: Date.now() - t0, firstMs, chunks }, 'ai chat step failed');
              if (stall.signal.aborted && !abort.signal.aborted)
                throw Object.assign(new Error('The model stopped responding. Try again, or pick another model.'), { stalled: true });
              throw err;
            })
            .finally(() => clearTimeout(timer));
          req.log.info({ step, ms: Date.now() - t0, firstMs, chunks, stop: r.stop, tools: r.toolCalls.map((c) => c.name) }, 'ai chat step');
          if (r.stop === 'refusal') {
            send({ type: 'error', message: 'The model declined this request.' });
            break;
          }
          if (r.stop === 'length' && !r.toolCalls.length) {
            send({ type: 'error', message: 'The reply was cut off because it got too long.' });
            break;
          }
          if (!r.toolCalls.length) break;
          if (step >= MAX_STEPS) {
            send({ type: 'error', message: 'Stopped after too many steps. Ask again to continue.' });
            break;
          }
          const results: ToolOutput[] = [];
          for (const call of r.toolCalls) results.push(await runTool(ctx, call, send, req));
          session.addToolResults(results);
        }
        send({ type: 'done' });
      } catch (err) {
        if (abort.signal.aborted) req.log.info('ai chat cancelled by the client');
        else {
          req.log.warn({ err, provider, model }, 'ai chat failed');
          send({ type: 'error', message: providerError(err) });
        }
      } finally {
        clearInterval(ping);
        reply.raw.end();
      }
    },
  );
}

async function runTool(
  ctx: Ctx,
  call: { id: string; name: string; args: string },
  send: (e: AiStreamEvent) => void,
  req: FastifyRequest,
): Promise<ToolOutput> {
  const t = AI_TOOLS.find((x) => x.name === call.name);
  send({ type: 'tool', id: call.id, name: call.name, title: t?.title ?? call.name });
  const fail = (content: string): ToolOutput => {
    send({ type: 'tool_result', id: call.id, ok: false, summary: content.slice(0, 300) });
    return { id: call.id, content, isError: true };
  };
  if (!t) return fail(`Unknown tool: ${call.name}`);
  let args: unknown;
  try {
    args = JSON.parse(call.args || '{}');
  } catch {
    return fail('The arguments were not valid JSON; call the tool again with valid JSON.');
  }
  const parsed = t.input.safeParse(args);
  if (!parsed.success) return fail(`Invalid arguments: ${z.prettifyError(parsed.error)}`);

  const editId = call.name === 'edit_document' ? (parsed.data as { documentId: string }).documentId : null;
  const markdown = (id: string) =>
    ctx.call<{ markdown: string }>('GET', `/api/documents/${id}/markdown`).then((r) => r.markdown);
  try {
    const before = editId ? await markdown(editId).catch(() => null) : null;
    let out = await t.run(parsed.data, ctx);
    const event: Extract<AiStreamEvent, { type: 'tool_result' }> = {
      type: 'tool_result',
      id: call.id,
      ok: true,
      summary: out.split('\n')[0]!.slice(0, 300),
    };
    if (editId && before !== null) {
      const [after, d] = await Promise.all([
        markdown(editId),
        ctx.call<{ document: DocumentDTO }>('GET', `/api/documents/${editId}`),
      ]);
      event.edit = { documentId: editId, title: d.document.title, before, after };
    }
    const created = call.name === 'create_document' && /^Created "(.*)" \(id: ([0-9a-f-]{36})\)/.exec(out);
    if (created) event.created = { documentId: created[2]!, title: created[1]! };
    send(event);
    if (out.length > MAX_TOOL_RESULT) out = `${out.slice(0, MAX_TOOL_RESULT)}\n\n[truncated]`;
    return { id: call.id, content: out, isError: false };
  } catch (err) {
    if (err instanceof ToolError || (err as { status?: number }).status) return fail((err as Error).message);
    req.log.error({ err, tool: t.name }, 'ai tool failed');
    return fail('Internal error');
  }
}

/** A readable message for provider failures (bad key, no credits, rate limits). */
function providerError(err: unknown): string {
  const e = err as { status?: number; message?: string; stalled?: boolean };
  if (e.stalled) return e.message!;
  if (e.status === 401 || e.status === 403)
    return 'Your AI account rejected the request. Reconnect it in Ask AI settings.';
  if (e.status === 402) return 'Your AI account is out of credits.';
  if (e.status === 429) return 'Your AI account hit its rate limit or quota for this model. Wait a moment, or pick another model.';
  if (e.status === 404) return 'This model is not available to your AI account. Pick another model.';
  if (e.status === 503 || e.status === 529)
    return 'The model is overloaded at the provider right now. Try again in a moment, or pick another model.';
  return e.message ? `The AI provider returned an error: ${e.message.slice(0, 300)}` : 'The AI request failed.';
}

/** Only same-site paths, so the callback cannot redirect elsewhere. */
function safeNext(next: string | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/';
}

/** Tells the opener (the chat that opened the sign-in popup) and closes; else navigates back. */
function callbackPage(ok: boolean, next: string): string {
  const msg = JSON.stringify({ type: 'bee-ai-signin', ok });
  const back = JSON.stringify(next + (next.includes('?') ? '&' : '?') + `ai=${ok ? 'connected' : 'failed'}`);
  return `<!doctype html><meta charset="utf-8"><title>Bee</title><body style="font:14px system-ui;padding:24px">${ok ? 'Connected. You can close this window.' : 'Sign-in did not complete. You can close this window.'}<script>
if (window.opener) { window.opener.postMessage(${msg}, location.origin); window.close(); }
else location.replace(${back.replace(/</g, '\\u003c')});
</script>`;
}

