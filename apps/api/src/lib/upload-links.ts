import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived signed upload links for MCP clients that have a file on disk: insert_image with
 * `upload: true` hands out a URL the client PUTs the bytes to (curl -T), which is far more
 * reliable than pasting a large base64 string into tool arguments. The link carries who may
 * upload to which document and until when; access is checked again when it is used.
 */

export interface UploadTicket {
  /** document id */
  d: string;
  /** user id */
  u: string;
  /** expiry, ms since epoch */
  e: number;
  /** filename hint */
  n?: string;
}

export const UPLOAD_LINK_TTL_MS = 15 * 60 * 1000;

const sign = (secret: string, body: string) =>
  createHmac('sha256', `upload-link:${secret}`).update(body).digest('base64url');

export function createUploadTicket(secret: string, t: UploadTicket): string {
  const body = Buffer.from(JSON.stringify(t)).toString('base64url');
  return `${body}.${sign(secret, body)}`;
}

/** The ticket's contents, or null when it is forged, malformed or expired. */
export function readUploadTicket(
  secret: string,
  ticket: string,
  now = Date.now(),
): UploadTicket | null {
  const [body, mac] = ticket.split('.');
  if (!body || !mac) return null;
  const want = Buffer.from(sign(secret, body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  try {
    const t = JSON.parse(Buffer.from(body, 'base64url').toString()) as UploadTicket;
    if (typeof t.d !== 'string' || typeof t.u !== 'string' || typeof t.e !== 'number') return null;
    return t.e > now ? t : null;
  } catch {
    return null;
  }
}
