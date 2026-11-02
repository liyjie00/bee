import type { FastifyInstance } from 'fastify';
import type { MeResponse } from '@bee/shared';
import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { users } from '@bee/db';
import { userDTO } from '../lib/dto.js';
import { badRequest, HttpError, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';
import { requireUser, userWorkspaces } from './auth.js';

/** The web app shrinks avatars to 256px before uploading, so this is generous. */
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};
const PREFIX = '/api/avatars/';
const fileParams = z.object({ file: z.string().regex(/^[0-9a-f-]{36}\.(png|jpg|gif|webp)$/) });

/** The image type from the file's first bytes; the client's MIME type is not trusted. */
function sniff(b: Buffer): string | null {
  if (b.length > 8 && b.readUInt32BE(0) === 0x89504e47) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length > 6 && b.toString('latin1', 0, 4) === 'GIF8') return 'gif';
  if (
    b.length > 12 &&
    b.toString('latin1', 0, 4) === 'RIFF' &&
    b.toString('latin1', 8, 12) === 'WEBP'
  )
    return 'webp';
  return null;
}

/**
 * Uploaded profile pictures. Stored under <uploadDir>/avatars with a random name and served
 * without auth, like any avatar: they show next to comments on public links too.
 */
export async function avatarRoutes(app: FastifyInstance) {
  const { db, config } = app;
  const dir = join(resolve(config.uploadDir), 'avatars');

  const me = async (u: typeof users.$inferSelect): Promise<MeResponse> => ({
    user: userDTO(u),
    workspaces: await userWorkspaces(db, u.id),
  });

  /** Removes the previous uploaded file when an avatar is replaced or cleared. */
  const dropOld = async (url: string | null) => {
    if (!url?.startsWith(PREFIX)) return;
    const name = url.slice(PREFIX.length);
    if (fileParams.safeParse({ file: name }).success) await unlink(join(dir, name)).catch(() => {});
  };

  app.post('/auth/me/avatar', async (req) => {
    const user = requireUser(req);
    const file = await req.file();
    if (!file) throw badRequest('Missing file');
    const buf = await file.toBuffer();
    if (buf.length > MAX_AVATAR_BYTES)
      throw new HttpError(413, 'too_large', 'Image is larger than 2 MB');
    const ext = sniff(buf);
    if (!ext) throw badRequest('Use a PNG, JPEG, GIF or WebP image', 'bad_image');
    const name = `${randomUUID()}.${ext}`;
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), buf);
    const [u] = await db
      .update(users)
      .set({ avatarUrl: PREFIX + name, updatedAt: new Date() })
      .where(eq(users.id, user.id))
      .returning();
    await dropOld(user.avatarUrl);
    return me(u!);
  });

  app.delete('/auth/me/avatar', async (req) => {
    const user = requireUser(req);
    const [u] = await db
      .update(users)
      .set({ avatarUrl: null, updatedAt: new Date() })
      .where(eq(users.id, user.id))
      .returning();
    await dropOld(user.avatarUrl);
    return me(u!);
  });

  app.get('/avatars/:file', async (req, reply) => {
    const { file } = parse(fileParams, req.params);
    const path = join(dir, file);
    const s = await stat(path).catch(() => null);
    if (!s) throw notFound('Avatar not found');
    return reply
      .header('content-type', MIME[file.split('.')[1]!]!)
      .header('content-length', s.size)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'")
      .header('cache-control', 'public, max-age=31536000, immutable')
      .send(createReadStream(path));
  });
}
