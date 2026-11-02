import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { apiTokens, oauthClients, oauthCodes } from '@bee/db';
import { SESSION_COOKIE } from '@bee/shared';
import { randomToken } from '../lib/auth.js';
import {
  ACCESS_TTL_MS,
  findToken,
  issueToken,
  pruneTokens,
  REFRESH_TTL_MS,
  sha256,
} from '../lib/tokens.js';

/**
 * OAuth 2.1 authorization server for MCP clients (e.g. Claude custom connectors):
 * RFC 8414 / RFC 9728 metadata, dynamic client registration (RFC 7591), and the
 * authorization code flow with PKCE (S256 only). Public clients only: the user signs
 * in with their Bee account and approves the client on a consent page.
 */

const CODE_TTL_MS = 10 * 60 * 1000;
const SCOPE = 'bee';

type OAuthClient = typeof oauthClients.$inferSelect;

/** OAuth-style error response (RFC 6749 §5.2), not Bee's `{ error: { code } }` shape. */
const oauthError = (reply: FastifyReply, status: number, error: string, description: string) =>
  reply
    .status(status)
    .header('cache-control', 'no-store')
    .send({ error, error_description: description });

function validRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.hash) return false;
    if (u.protocol === 'https:') return true;
    // Native / CLI clients listen on a loopback port.
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

const registerBody = z.object({
  client_name: z.string().trim().max(200).optional(),
  redirect_uris: z.array(z.string().max(2000)).min(1).max(20),
  grant_types: z.array(z.string()).optional(),
  response_types: z.array(z.string()).optional(),
  token_endpoint_auth_method: z.string().optional(),
});

const authorizeParams = z.object({
  response_type: z.string(),
  client_id: z.string().max(200),
  redirect_uri: z.string().max(2000).optional(),
  code_challenge: z.string().min(43).max(128),
  code_challenge_method: z.string().optional(),
  state: z.string().max(2000).optional(),
  scope: z.string().max(500).optional(),
  resource: z.string().max(2000).optional(),
});
type AuthorizeParams = z.infer<typeof authorizeParams>;

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

const T = {
  en: {
    title: 'Authorize access',
    lead: (c: string) =>
      `<strong>${c}</strong> wants to access your Bee account. It will be able to read and edit the folders, documents and comments you can access, as you.`,
    signedInAs: 'Signed in as',
    redirect: 'You will be sent back to',
    allow: 'Allow',
    deny: 'Cancel',
    error: 'Authorization failed',
  },
  zh: {
    title: '授权访问',
    lead: (c: string) =>
      `<strong>${c}</strong> 请求访问你的 Bee 账号。它将以你的身份读取和编辑你有权限访问的文件夹、文档和评论。`,
    signedInAs: '当前账号',
    redirect: '授权后将返回到',
    allow: '允许',
    deny: '取消',
    error: '授权失败',
  },
};
type Lang = keyof typeof T;
const langOf = (req: FastifyRequest): Lang =>
  /^zh/i.test(String(req.headers['accept-language'] ?? '')) ? 'zh' : 'en';

function page(lang: Lang, title: string, body: string) {
  return `<!doctype html><html lang="${lang === 'zh' ? 'zh-CN' : 'en'}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Bee</title>
<style>
:root{color-scheme:light dark;--bg:#f6f6f4;--card:#fff;--text:#1d1d1b;--muted:#6b6b66;--border:#e3e3de;--accent:#d9a400}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--card:#20201e;--text:#ededea;--muted:#9b9b95;--border:#33332f}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,"PingFang SC",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:28px;max-width:420px;width:100%}
h1{font-size:20px;margin:0 0 12px}p{margin:0 0 12px}.muted{color:var(--muted);font-size:13px;word-break:break-all}
.row{display:flex;gap:8px;margin-top:20px}button{flex:1;font:inherit;padding:9px 14px;border-radius:8px;border:1px solid var(--border);background:transparent;color:var(--text);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#1d1d1b;font-weight:600}
</style></head><body><div class="card">${body}</div></body></html>`;
}

export async function oauthRoutes(app: FastifyInstance) {
  const { db, config } = app;
  const issuer = config.publicUrl;
  const resource = `${issuer}/mcp`;

  const metadata = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [SCOPE],
  };
  const resourceMetadata = {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    scopes_supported: [SCOPE],
    resource_name: 'Bee',
  };
  app.get('/.well-known/oauth-authorization-server', async () => metadata);
  app.get('/.well-known/oauth-authorization-server/mcp', async () => metadata);
  app.get('/.well-known/oauth-protected-resource', async () => resourceMetadata);
  app.get('/.well-known/oauth-protected-resource/mcp', async () => resourceMetadata);

  app.post(
    '/oauth/register',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const parsed = registerBody.safeParse(req.body);
      if (!parsed.success)
        return oauthError(reply, 400, 'invalid_client_metadata', 'redirect_uris is required');
      const b = parsed.data;
      if (!b.redirect_uris.every(validRedirectUri))
        return oauthError(
          reply,
          400,
          'invalid_redirect_uri',
          'Redirect URIs must be https (or http on localhost)',
        );
      if (b.token_endpoint_auth_method && b.token_endpoint_auth_method !== 'none')
        return oauthError(
          reply,
          400,
          'invalid_client_metadata',
          'Only public clients (token_endpoint_auth_method "none") are supported',
        );
      const [c] = await db
        .insert(oauthClients)
        .values({
          id: `bee_client_${randomToken(16)}`,
          name: b.client_name || 'MCP client',
          redirectUris: b.redirect_uris,
        })
        .returning();
      return reply.status(201).send({
        client_id: c!.id,
        client_name: c!.name,
        redirect_uris: c!.redirectUris,
        client_id_issued_at: Math.floor(c!.createdAt.getTime() / 1000),
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        scope: SCOPE,
      });
    },
  );

  const loadClient = async (id: string): Promise<OAuthClient | null> => {
    const [c] = await db.select().from(oauthClients).where(eq(oauthClients.id, id));
    return c ?? null;
  };

  const errorPage = (req: FastifyRequest, reply: FastifyReply, status: number, msg: string) => {
    const t = T[langOf(req)];
    return reply
      .status(status)
      .type('text/html; charset=utf-8')
      .send(
        page(langOf(req), t.error, `<h1>${t.error}</h1><p class="muted">${escapeHtml(msg)}</p>`),
      );
  };

  /**
   * Validates an authorization request. Problems with the client or redirect URI are shown
   * to the user; everything else is reported back to the (verified) redirect URI.
   */
  const checkAuthorize = async (
    req: FastifyRequest,
    reply: FastifyReply,
    raw: unknown,
  ): Promise<{ p: AuthorizeParams; client: OAuthClient; redirectUri: string } | null> => {
    const parsed = authorizeParams.safeParse(raw);
    const q = (raw ?? {}) as Record<string, unknown>;
    const client = typeof q.client_id === 'string' ? await loadClient(q.client_id) : null;
    if (!client) {
      await errorPage(req, reply, 400, 'Unknown client_id');
      return null;
    }
    const redirectUri =
      typeof q.redirect_uri === 'string'
        ? q.redirect_uri
        : client.redirectUris.length === 1
          ? client.redirectUris[0]!
          : '';
    if (!client.redirectUris.includes(redirectUri)) {
      await errorPage(req, reply, 400, 'redirect_uri is not registered for this client');
      return null;
    }
    const fail = (error: string, description: string) => {
      const u = new URL(redirectUri);
      u.searchParams.set('error', error);
      u.searchParams.set('error_description', description);
      if (typeof q.state === 'string') u.searchParams.set('state', q.state);
      reply.redirect(u.toString());
      return null;
    };
    if (!parsed.success)
      return fail('invalid_request', 'Missing or invalid parameters (PKCE is required)');
    const p = parsed.data;
    if (p.response_type !== 'code')
      return fail('unsupported_response_type', 'Only "code" is supported');
    if ((p.code_challenge_method ?? 'plain') !== 'S256')
      return fail('invalid_request', 'code_challenge_method must be S256');
    return { p, client, redirectUri };
  };

  const csrfFor = (sessionToken: string, clientId: string) =>
    createHmac('sha256', config.sessionSecret)
      .update(`oauth:${sha256(sessionToken)}:${clientId}`)
      .digest('base64url');

  app.get('/oauth/authorize', async (req, reply) => {
    const ok = await checkAuthorize(req, reply, req.query);
    if (!ok) return reply;
    const { p, client, redirectUri } = ok;
    const sessionToken = req.cookies[SESSION_COOKIE];
    if (!req.user || !sessionToken) {
      return reply.redirect(`/login?next=${encodeURIComponent(req.url)}`);
    }
    const lang = langOf(req);
    const t = T[lang];
    const hidden = { ...p, redirect_uri: redirectUri, csrf: csrfFor(sessionToken, client.id) };
    const inputs = Object.entries(hidden)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(String(v))}">`)
      .join('');
    return reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('x-frame-options', 'DENY')
      .header('content-security-policy', "frame-ancestors 'none'")
      .send(
        page(
          lang,
          t.title,
          `<h1>${t.title}</h1><p>${t.lead(escapeHtml(client.name))}</p>
<p class="muted">${t.signedInAs} ${escapeHtml(req.user.name)} (${escapeHtml(req.user.email)})</p>
<p class="muted">${t.redirect} ${escapeHtml(new URL(redirectUri).origin)}</p>
<form method="post" action="/oauth/authorize">${inputs}<div class="row">
<button type="submit" name="action" value="deny">${t.deny}</button>
<button class="primary" type="submit" name="action" value="allow">${t.allow}</button></div></form>`,
        ),
      );
  });

  app.post('/oauth/authorize', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const ok = await checkAuthorize(req, reply, body);
    if (!ok) return reply;
    const { p, client, redirectUri } = ok;
    const sessionToken = req.cookies[SESSION_COOKIE];
    if (!req.user || !sessionToken) return errorPage(req, reply, 401, 'Sign in first');
    const expected = Buffer.from(csrfFor(sessionToken, client.id));
    const got = Buffer.from(String(body.csrf ?? ''));
    if (got.length !== expected.length || !timingSafeEqual(got, expected))
      return errorPage(req, reply, 403, 'Invalid form token, please try again');
    const back = new URL(redirectUri);
    if (p.state) back.searchParams.set('state', p.state);
    back.searchParams.set('iss', issuer);
    if (body.action !== 'allow') {
      back.searchParams.set('error', 'access_denied');
      return reply.redirect(back.toString());
    }
    const code = randomToken(32);
    await db.insert(oauthCodes).values({
      id: sha256(code),
      clientId: client.id,
      userId: req.user.id,
      redirectUri,
      codeChallenge: p.code_challenge,
      resource: p.resource ?? null,
      expiresAt: new Date(Date.now() + CODE_TTL_MS),
    });
    back.searchParams.set('code', code);
    return reply.redirect(back.toString());
  });

  const issuePair = async (userId: string, client: OAuthClient, grantId: string) => {
    const access = await issueToken(db, {
      userId,
      kind: 'oauth_access',
      name: client.name,
      clientId: client.id,
      grantId,
      ttlMs: ACCESS_TTL_MS,
    });
    const refresh = await issueToken(db, {
      userId,
      kind: 'oauth_refresh',
      name: client.name,
      clientId: client.id,
      grantId,
      ttlMs: REFRESH_TTL_MS,
    });
    return {
      access_token: access.token,
      token_type: 'Bearer',
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token: refresh.token,
      scope: SCOPE,
    };
  };

  app.post(
    '/oauth/token',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, string | undefined>;
      reply.header('cache-control', 'no-store');
      const client = b.client_id ? await loadClient(b.client_id) : null;
      if (b.grant_type === 'authorization_code') {
        if (!b.code || !b.code_verifier)
          return oauthError(reply, 400, 'invalid_request', 'code and code_verifier are required');
        // Codes are single use: delete first, then check.
        const [row] = await db
          .delete(oauthCodes)
          .where(eq(oauthCodes.id, sha256(b.code)))
          .returning();
        if (!row || row.expiresAt.getTime() < Date.now())
          return oauthError(reply, 400, 'invalid_grant', 'Invalid or expired code');
        if (!client || client.id !== row.clientId)
          return oauthError(reply, 400, 'invalid_grant', 'Code was issued to another client');
        if (b.redirect_uri && b.redirect_uri !== row.redirectUri)
          return oauthError(reply, 400, 'invalid_grant', 'redirect_uri mismatch');
        const challenge = createHash('sha256').update(b.code_verifier).digest('base64url');
        if (challenge !== row.codeChallenge)
          return oauthError(reply, 400, 'invalid_grant', 'PKCE verification failed');
        void pruneTokens(db).catch(() => {});
        return issuePair(row.userId, client, randomUUID());
      }
      if (b.grant_type === 'refresh_token') {
        if (!b.refresh_token)
          return oauthError(reply, 400, 'invalid_request', 'refresh_token is required');
        const hit = await findToken(db, b.refresh_token, ['oauth_refresh']);
        if (!hit || !client || hit.row.clientId !== client.id)
          return oauthError(reply, 400, 'invalid_grant', 'Invalid refresh token');
        // Rotate: the old refresh token stops working.
        await db.delete(apiTokens).where(eq(apiTokens.id, hit.row.id));
        return issuePair(hit.user.id, client, hit.row.grantId ?? randomUUID());
      }
      return oauthError(reply, 400, 'unsupported_grant_type', 'Unsupported grant_type');
    },
  );

  /** RFC 7009: revoking either token of a grant revokes the whole grant. */
  app.post('/oauth/revoke', async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, string | undefined>;
    if (b.token) {
      const hit = await findToken(db, b.token, ['oauth_access', 'oauth_refresh']);
      if (hit?.row.grantId)
        await db
          .delete(apiTokens)
          .where(and(eq(apiTokens.userId, hit.user.id), eq(apiTokens.grantId, hit.row.grantId)));
    }
    return reply.status(200).send({});
  });
}
