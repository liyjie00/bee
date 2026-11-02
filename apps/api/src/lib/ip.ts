import type { FastifyRequest } from 'fastify';

/**
 * The visitor's IP. Behind Cloudflare Tunnel -> Caddy, `req.ip` is the tunnel's
 * address for everyone (Caddy replaces X-Forwarded-For from untrusted peers), so
 * prefer the CF-Connecting-IP header Cloudflare sets on every request.
 */
export function clientIp(req: FastifyRequest): string {
  const cf = req.headers['cf-connecting-ip'];
  return typeof cf === 'string' && cf.length > 0 && cf.length <= 45 ? cf : req.ip;
}
