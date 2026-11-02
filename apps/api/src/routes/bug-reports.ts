import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { and, count, eq, gt } from 'drizzle-orm';
import { bugReports, type BugReportImage } from '@bee/db';
import { getMailer } from '../lib/delivery.js';
import { badRequest, HttpError } from '../lib/errors.js';
import { clientIp } from '../lib/ip.js';
import { requireUser } from './auth.js';

const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_BODY_CHARS = 10_000;
const DAILY_LIMIT = 30;
const IMAGE = /^image\/(png|jpe?g|gif|webp|heic|heif|avif)$/;
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg' };

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Keeps a small map of short strings from the client's diagnostics. */
function cleanMeta(raw: string): Record<string, string> | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
    const out: Record<string, string> = {};
    for (const [k, x] of Object.entries(v).slice(0, 12)) {
      if (typeof x === 'string' || typeof x === 'number') out[k.slice(0, 40)] = String(x).slice(0, 500);
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

const META_LABELS: Record<string, string> = {
  url: 'Page',
  userAgent: 'Browser',
  viewport: 'Window',
  screen: 'Screen',
  language: 'Language',
  timeZone: 'Time zone',
};

/** "Report a problem": saved here, and emailed to BUG_REPORT_TO when SMTP is configured. */
export async function bugReportRoutes(app: FastifyInstance) {
  const { db, config } = app;
  const root = resolve(config.uploadDir);

  app.post(
    '/bug-reports',
    {
      config: {
        rateLimit: {
          hook: 'preHandler' as const,
          max: 5,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest) =>
            req.user ? `bug:${req.user.id}` : `bug-ip:${clientIp(req)}`,
        },
      },
    },
    async (req, reply) => {
      const user = requireUser(req);
      const [recent] = await db
        .select({ n: count() })
        .from(bugReports)
        .where(
          and(eq(bugReports.userId, user.id), gt(bugReports.createdAt, new Date(Date.now() - 86_400_000))),
        );
      if ((recent?.n ?? 0) >= DAILY_LIMIT) {
        throw new HttpError(429, 'rate_limited', 'Too many reports today, try again tomorrow');
      }

      const folder = join('bug-reports', randomUUID());
      const images: BugReportImage[] = [];
      let body = '';
      let meta: Record<string, string> | null = null;
      try {
        const parts = req.parts({
          limits: { files: MAX_IMAGES, fileSize: MAX_IMAGE_BYTES, fields: 4, fieldSize: 64 * 1024 },
        });
        for await (const part of parts) {
          if (part.type === 'field') {
            if (part.fieldname === 'body') body = String(part.value);
            else if (part.fieldname === 'meta') meta = cleanMeta(String(part.value));
            continue;
          }
          const mime = (part.mimetype || '').toLowerCase();
          if (!IMAGE.test(mime)) {
            part.file.resume();
            throw badRequest('Only images can be attached', 'not_image');
          }
          if (!images.length) await mkdir(join(root, folder), { recursive: true });
          const ext = EXT[mime] ?? mime.split('/')[1];
          const storageKey = join(folder, `${images.length + 1}.${ext}`);
          await pipeline(part.file, createWriteStream(join(root, storageKey)));
          if (part.file.truncated) {
            throw new HttpError(413, 'too_large', `Each image must be under ${MAX_IMAGE_BYTES / 1048576} MB`);
          }
          const filename = (part.filename || `image-${images.length + 1}.${ext}`).slice(0, 200);
          images.push({ filename, mime, size: part.file.bytesRead, storageKey });
        }
        body = body.replace(/\r\n?/g, '\n').trim();
        if (!body) throw badRequest('Describe the problem', 'empty');
        if (body.length > MAX_BODY_CHARS) throw badRequest('Description is too long', 'too_long');
      } catch (err) {
        await rm(join(root, folder), { recursive: true, force: true });
        throw err;
      }

      const [row] = await db
        .insert(bugReports)
        .values({ userId: user.id, name: user.name, email: user.email, body, meta, images })
        .returning();
      const report = row!;

      const mailer = getMailer();
      if (mailer && config.bugReportTo) {
        const firstLine = body.split('\n')[0]!.slice(0, 80);
        const metaRows = Object.entries(meta ?? {}).map(
          ([k, v]) =>
            `<tr><td style="color:#4a5146;padding:2px 16px 2px 0;vertical-align:top">${esc(META_LABELS[k] ?? k)}</td><td>${esc(v)}</td></tr>`,
        );
        try {
          await mailer.sendMail({
            from: config.mailFrom,
            to: config.bugReportTo,
            replyTo: { name: user.name, address: user.email },
            subject: `[Bee Bug #${report.id}] ${firstLine}`,
            text:
              `From: ${user.name} <${user.email}> (user ${user.id})\n\n${body}\n\n` +
              Object.entries(meta ?? {})
                .map(([k, v]) => `${META_LABELS[k] ?? k}: ${v}`)
                .join('\n'),
            html:
              `<div style="font-family:-apple-system,'PingFang SC',sans-serif;font-size:14px;color:#1d211b;max-width:640px">` +
              `<p style="color:#4a5146;margin:0 0 12px">${esc(user.name)} &lt;${esc(user.email)}&gt; · user ${esc(user.id)}</p>` +
              `<div style="white-space:pre-wrap;line-height:1.6;background:#f6f7f4;border:1px solid #e1e4dc;border-radius:8px;padding:12px 14px">${esc(body)}</div>` +
              (metaRows.length
                ? `<table style="margin-top:16px;font-size:13px;border-collapse:collapse">${metaRows.join('')}</table>`
                : '') +
              `<p style="color:#7b8375;font-size:12px;margin-top:16px">Bee bug report #${report.id} · ${images.length} image(s) attached</p></div>`,
            attachments: images.map((im) => ({
              filename: im.filename,
              path: join(root, im.storageKey),
              contentType: im.mime,
            })),
          });
          await db.update(bugReports).set({ emailedAt: new Date() }).where(eq(bugReports.id, report.id));
        } catch (err) {
          req.log.error({ err, report: report.id }, 'bug report email failed');
          await db
            .update(bugReports)
            .set({ emailError: String((err as Error).message ?? err).slice(0, 500) })
            .where(eq(bugReports.id, report.id));
        }
      }
      return reply.status(201).send({ id: report.id });
    },
  );
}
