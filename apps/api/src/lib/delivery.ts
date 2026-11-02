/* Email and Web Push delivery of in-app notifications. Both are off unless configured. */
import type { FastifyInstance } from 'fastify';
import { and, asc, eq, inArray, isNull, lt } from 'drizzle-orm';
import nodemailer, { type Transporter } from 'nodemailer';
import webpush from 'web-push';
import { documents, folders, notifications, pushSubscriptions, users, type Db } from '@bee/db';
import type { NotificationKind, UserPrefs } from '@bee/shared';
import type { Config } from '../env.js';

type Row = typeof notifications.$inferSelect;
type Lang = 'zh-CN' | 'en';

/** Emails wait this long so a burst of comments on one document becomes one email. */
const EMAIL_DELAY_MS = 3 * 60_000;
/** ...but a busy thread still gets one within this long. */
const EMAIL_MAX_WAIT_MS = 10 * 60_000;
/** Older unsent ones (e.g. from before email was configured) are dropped, not sent. */
const EMAIL_MAX_AGE_MS = 24 * 3600_000;

let config: Config | null = null;
let mailer: Transporter | null = null;
let push = false;

/** Tests: swap in a transport (e.g. nodemailer's jsonTransport). */
export function setMailer(t: Transporter | null) {
  mailer = t;
}

/** The configured SMTP transport, or null when email is off. */
export function getMailer(): Transporter | null {
  return mailer;
}

export function deliveryEnabled() {
  return { email: !!mailer, push, vapidPublicKey: push ? config!.vapidPublicKey : null };
}

const ROLE: Record<Lang, Record<string, string>> = {
  'zh-CN': { viewer: '可查看', commenter: '可评论', editor: '可编辑' },
  en: { viewer: 'view', commenter: 'comment', editor: 'edit' },
};

export interface Described {
  title: string;
  body: string;
  /** path on the Bee site */
  path: string;
}

/** Text of a notification, as the inbox shows it. */
export function describe(
  n: Pick<Row, 'kind' | 'detail' | 'documentId' | 'folderId' | 'threadId'>,
  actor: string,
  where: string,
  lang: Lang,
): Described {
  const zh = lang === 'zh-CN';
  const role = ROLE[lang][n.detail ?? ''] ?? n.detail ?? '';
  const doc = n.documentId
    ? `/d/${n.documentId}`
    : n.folderId
      ? `/f/${n.folderId}`
      : '/notifications';
  const thread = n.threadId ? `${doc}?comment=${n.threadId}` : doc;
  switch (n.kind) {
    case 'mention':
      return {
        title: zh ? `${actor} 在「${where}」中提到了你` : `${actor} mentioned you in “${where}”`,
        body: n.detail ?? '',
        path: thread,
      };
    case 'reply':
      return {
        title: zh ? `${actor} 回复了「${where}」中的评论` : `${actor} replied in “${where}”`,
        body: n.detail ?? '',
        path: thread,
      };
    case 'share':
      return {
        title: zh ? `${actor} 把「${where}」分享给你` : `${actor} shared “${where}” with you`,
        body: zh ? `权限：${role}` : `You can ${role}`,
        path: doc,
      };
    case 'access_request':
      return {
        title: zh ? `${actor} 申请访问「${where}」` : `${actor} asked for access to “${where}”`,
        body: n.detail ?? '',
        path: '/notifications',
      };
  }
}

export const langOf = (prefs: UserPrefs | null | undefined): Lang =>
  prefs?.lang === 'en' ? 'en' : 'zh-CN';
const muted = (prefs: UserPrefs | null | undefined, kind: NotificationKind) =>
  !!prefs?.mutedNotifications?.includes(kind);

/** Names of the actors, documents and folders the rows refer to. */
async function names(db: Db, rows: Row[]) {
  const ids = (k: 'actorId' | 'documentId' | 'folderId') => [
    ...new Set(rows.map((r) => r[k]).filter((x): x is string => !!x)),
  ];
  const [a, d, f] = await Promise.all([
    ids('actorId').length
      ? db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(inArray(users.id, ids('actorId')))
      : [],
    ids('documentId').length
      ? db
          .select({ id: documents.id, name: documents.title })
          .from(documents)
          .where(inArray(documents.id, ids('documentId')))
      : [],
    ids('folderId').length
      ? db
          .select({ id: folders.id, name: folders.name })
          .from(folders)
          .where(inArray(folders.id, ids('folderId')))
      : [],
  ]);
  const m = new Map([...a, ...d, ...f].map((x) => [x.id, x.name]));
  return {
    actor: (r: Row) => (r.actorId ? m.get(r.actorId) : r.actorName) || 'Someone',
    where: (r: Row, lang: Lang) =>
      m.get(r.documentId ?? r.folderId ?? '') || (lang === 'en' ? 'Untitled' : '无标题'),
  };
}

/** Sends new notifications to the browsers their recipients turned push on in. */
export async function pushNow(db: Db, rows: Row[]): Promise<void> {
  if (!push || !rows.length) return;
  try {
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const [subs, people, n] = await Promise.all([
      db.select().from(pushSubscriptions).where(inArray(pushSubscriptions.userId, userIds)),
      db.select({ id: users.id, prefs: users.prefs }).from(users).where(inArray(users.id, userIds)),
      names(db, rows),
    ]);
    const prefs = new Map(people.map((p) => [p.id, p.prefs]));
    const gone: string[] = [];
    await Promise.all(
      rows.flatMap((r) => {
        const p = prefs.get(r.userId);
        if (muted(p, r.kind)) return [];
        const lang = langOf(p);
        const d = describe(r, n.actor(r), n.where(r, lang), lang);
        const payload = JSON.stringify({
          ...d,
          url: config!.publicUrl + d.path,
          tag: r.threadId ?? r.id,
        });
        return subs
          .filter((s) => s.userId === r.userId)
          .map((s) =>
            webpush
              .sendNotification(
                { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
                payload,
                {
                  TTL: 3600,
                },
              )
              .catch((err: { statusCode?: number }) => {
                if (err.statusCode === 404 || err.statusCode === 410) gone.push(s.id);
              }),
          );
      }),
    );
    if (gone.length) await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, gone));
  } catch (err) {
    console.error('push failed', err);
  }
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function emailHtml(items: Described[], lang: Lang, base: string): string {
  const zh = lang === 'zh-CN';
  const open = zh ? '打开' : 'Open';
  const rows = items
    .map(
      (d) => `<tr><td style="padding:12px 0;border-bottom:1px solid #eef0eb">
<div style="font-weight:600;color:#1d211b">${esc(d.title)}</div>
${d.body ? `<div style="margin:6px 0;border-left:3px solid #e8a317;padding:4px 10px;background:#f6f7f4;color:#4a5146">${esc(d.body)}</div>` : ''}
<a href="${esc(base + d.path)}" style="color:#7a4f00">${open} →</a></td></tr>`,
    )
    .join('');
  const foot = zh
    ? '不想收到这类邮件？在 Bee 的「设置 › 通知」里关闭。'
    : 'Turn these emails off in Bee under Settings › Notifications.';
  return `<div style="font-family:-apple-system,'PingFang SC',sans-serif;font-size:14px;line-height:1.55;max-width:560px">
<div style="font-weight:700;font-size:18px;margin-bottom:8px">bee</div><table style="width:100%;border-collapse:collapse">${rows}</table>
<p style="font-size:12px;color:#7b8375"><a href="${esc(base)}/settings" style="color:#7b8375">${foot}</a></p></div>`;
}

/** One email per person and document for notifications they have not read in Bee yet. */
export async function sendEmailDigests(db: Db): Promise<number> {
  if (!mailer) return 0;
  const now = Date.now();
  const due = await db
    .select()
    .from(notifications)
    .where(
      and(
        isNull(notifications.emailedAt),
        lt(notifications.createdAt, new Date(now - EMAIL_DELAY_MS / 3)),
      ),
    )
    .orderBy(asc(notifications.createdAt))
    .limit(500);
  if (!due.length) return 0;
  const groups = new Map<string, Row[]>();
  for (const r of due) {
    const k = `${r.userId}:${r.documentId ?? r.folderId ?? r.id}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const userIds = [...new Set(due.map((r) => r.userId))];
  const [people, n] = await Promise.all([
    db
      .select({ id: users.id, email: users.email, prefs: users.prefs })
      .from(users)
      .where(inArray(users.id, userIds)),
    names(db, due),
  ]);
  const byId = new Map(people.map((p) => [p.id, p]));
  let sent = 0;
  for (const rows of groups.values()) {
    const newest = rows[rows.length - 1]!.createdAt.getTime();
    const oldest = rows[0]!.createdAt.getTime();
    // Wait for a quiet moment, unless the group has waited long enough.
    if (now - newest < EMAIL_DELAY_MS && now - oldest < EMAIL_MAX_WAIT_MS) continue;
    const u = byId.get(rows[0]!.userId);
    const lang = langOf(u?.prefs);
    const wanted = rows.filter(
      (r) =>
        !r.readAt && now - r.createdAt.getTime() < EMAIL_MAX_AGE_MS && !muted(u?.prefs, r.kind),
    );
    const ok = u && u.prefs?.emailNotifications !== false && wanted.length > 0;
    if (ok) {
      const items = wanted.map((r) => describe(r, n.actor(r), n.where(r, lang), lang));
      const subject =
        items.length === 1
          ? items[0]!.title
          : lang === 'zh-CN'
            ? `「${n.where(wanted[0]!, lang)}」有 ${items.length} 条新消息`
            : `${items.length} updates in “${n.where(wanted[0]!, lang)}”`;
      try {
        await mailer.sendMail({
          from: config!.mailFrom,
          to: u.email,
          subject,
          text: items
            .map((d) => `${d.title}\n${d.body}\n${config!.publicUrl}${d.path}`)
            .join('\n\n'),
          html: emailHtml(items, lang, config!.publicUrl),
        });
        sent++;
      } catch (err) {
        console.error('notification email failed', err);
        continue; // retried next round
      }
    }
    await db
      .update(notifications)
      .set({ emailedAt: new Date() })
      .where(
        inArray(
          notifications.id,
          rows.map((r) => r.id),
        ),
      );
  }
  return sent;
}

export function setupDelivery(app: FastifyInstance, db: Db, cfg: Config) {
  config = cfg;
  mailer = cfg.smtpUrl ? nodemailer.createTransport(cfg.smtpUrl) : null;
  push = !!(cfg.vapidPublicKey && cfg.vapidPrivateKey);
  // The VAPID subject must be an https URL or a mailto: address.
  const subject = cfg.publicUrl.startsWith('https:') ? cfg.publicUrl : 'mailto:admin@localhost';
  if (push) webpush.setVapidDetails(subject, cfg.vapidPublicKey!, cfg.vapidPrivateKey!);
  if (!mailer) return;
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    sendEmailDigests(db)
      .catch((err) => app.log.error({ err }, 'email digest failed'))
      .finally(() => (busy = false));
  }, 60_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}

/** Inserts notifications and pushes them to their recipients' browsers. */
export async function insertNotifications(
  db: Db,
  values: (typeof notifications.$inferInsert)[],
): Promise<void> {
  if (!values.length) return;
  const rows = await db.insert(notifications).values(values).returning();
  void pushNow(db, rows);
}

/** A sample notification to the caller's browsers, from Settings. */
export async function pushTest(db: Db, userId: string, lang: Lang): Promise<void> {
  if (!push) return;
  const subs = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));
  const title = lang === 'en' ? 'Bee notifications are on' : 'Bee 浏览器通知已开启';
  const body =
    lang === 'en'
      ? 'You will see mentions, replies and shares here.'
      : '被 @、回复和分享会在这里提醒你。';
  const payload = JSON.stringify({
    title,
    body,
    url: config!.publicUrl + '/notifications',
    tag: 'bee-test',
  });
  await Promise.all(
    subs.map((s) =>
      webpush
        .sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
        )
        .catch(() => {}),
    ),
  );
}

export async function savePushSubscription(
  db: Db,
  userId: string,
  s: { endpoint: string; keys: { p256dh: string; auth: string } },
) {
  await db
    .insert(pushSubscriptions)
    .values({ userId, endpoint: s.endpoint, p256dh: s.keys.p256dh, auth: s.keys.auth })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId, p256dh: s.keys.p256dh, auth: s.keys.auth },
    });
}

export async function deletePushSubscription(db: Db, userId: string, endpoint: string) {
  await db
    .delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)));
}
