import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { uploads } from '@bee/db';
import { can } from '@bee/shared';
import { docAccess } from '../lib/access.js';
import { imageExt, sniffImage } from '../lib/images.js';
import { readUploadTicket } from '../lib/upload-links.js';
import { badRequest, forbidden, HttpError, notFound } from '../lib/errors.js';
import { idParams, parse } from '../lib/validate.js';
import { z } from 'zod';
import { requireUser } from './auth.js';

/** MIME types served inline; everything else is downloaded as an attachment. */
const INLINE =
  /^(image\/(png|jpe?g|gif|webp|avif)|video\/(mp4|webm)|audio\/(mpeg|ogg|wav)|application\/pdf)$/;

export async function uploadRoutes(app: FastifyInstance) {
  const { db, config } = app;
  const root = resolve(config.uploadDir);

  app.post('/documents/:id/uploads', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const a = await docAccess(db, { userId: user.id, documentId: id, shareToken: req.shareToken });
    if (!can.edit(a.role)) throw forbidden('You cannot upload to this document');
    const file = await req.file();
    if (!file) throw badRequest('Missing file');
    const fileId = randomUUID();
    const key = join(a.doc.workspaceId, fileId);
    await mkdir(join(root, a.doc.workspaceId), { recursive: true });
    const dest = join(root, key);
    await pipeline(file.file, createWriteStream(dest));
    if (file.file.truncated) {
      await unlink(dest).catch(() => {});
      throw new HttpError(
        413,
        'too_large',
        `File is larger than ${Math.round(config.maxUploadBytes / 1048576)} MB`,
      );
    }
    const size = file.file.bytesRead;
    const filename = (file.filename || 'file').slice(0, 255);
    const mime = (file.mimetype || 'application/octet-stream').slice(0, 100);
    await db.insert(uploads).values({
      id: fileId,
      workspaceId: a.doc.workspaceId,
      documentId: id,
      filename,
      mime,
      size,
      storageKey: key,
      createdById: user.id,
    });
    return reply
      .status(201)
      .send({ id: fileId, url: `/api/uploads/${fileId}`, filename, mime, size });
  });

  /**
   * Signed upload link from the MCP insert_image tool (upload: true): the raw image bytes as the
   * body (curl -T file <url>), no cookie or token. Only images; the caller then inserts the
   * returned uploadId with insert_image.
   */
  await app.register(async (links) => {
    links.removeAllContentTypeParsers();
    links.addContentTypeParser(
      '*',
      { parseAs: 'buffer', bodyLimit: config.maxUploadBytes },
      (_req, body, done) => done(null, body),
    );
    const handler = async (req: FastifyRequest, reply: FastifyReply) => {
      const { ticket } = parse(z.object({ ticket: z.string().max(2000) }), req.params);
      const t = readUploadTicket(config.sessionSecret, ticket);
      if (!t) throw new HttpError(403, 'bad_link', 'This upload link is invalid or has expired');
      const a = await docAccess(db, { userId: t.u, documentId: t.d });
      if (!can.edit(a.role)) throw forbidden('You cannot upload to this document');
      const data = Buffer.isBuffer(req.body) ? req.body : null;
      if (!data?.length)
        throw badRequest('Send the image bytes as the request body (curl -T file URL)');
      const mime = sniffImage(data);
      if (!mime) throw badRequest('Not a PNG, JPEG, GIF, WebP or AVIF image', 'not_image');
      const fileId = randomUUID();
      const key = join(a.doc.workspaceId, fileId);
      await mkdir(join(root, a.doc.workspaceId), { recursive: true });
      await writeFile(join(root, key), data);
      let filename = (t.n || 'image').replace(/[\\/\r\n]/g, '_').slice(0, 200);
      if (!/\.[a-z0-9]{2,5}$/i.test(filename)) filename += `.${imageExt(mime)}`;
      await db.insert(uploads).values({
        id: fileId,
        workspaceId: a.doc.workspaceId,
        documentId: t.d,
        filename,
        mime,
        size: data.length,
        storageKey: key,
        createdById: t.u,
      });
      return reply.status(201).send({
        uploadId: fileId,
        url: `/api/uploads/${fileId}`,
        filename,
        mime,
        size: data.length,
        next: `Call insert_image with documentId ${t.d} and uploadId ${fileId} to place it.`,
      });
    };
    const limit = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };
    links.put('/upload-links/:ticket', limit, handler);
    links.post('/upload-links/:ticket', limit, handler);
  });

  /** Authorized by the owning document; pass ?share=<token> for share-link visitors. */
  app.get('/uploads/:id', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const [u] = await db.select().from(uploads).where(eq(uploads.id, id));
    if (!u || !u.documentId) throw notFound('File not found');
    await docAccess(db, {
      userId: req.user?.id ?? null,
      documentId: u.documentId,
      shareToken: req.shareToken,
    });
    const inline = INLINE.test(u.mime);
    return reply
      .header('content-type', inline ? u.mime : 'application/octet-stream')
      .header('content-length', u.size)
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=86400')
      .header(
        'content-disposition',
        `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(u.filename)}`,
      )
      .send(createReadStream(join(root, u.storageKey)));
  });
}
