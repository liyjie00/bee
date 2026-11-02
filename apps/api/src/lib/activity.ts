import { and, desc, eq, gt } from 'drizzle-orm';
import { activity, type Db } from '@bee/db';
import type { ActivityItem } from '@bee/shared';

export async function logActivity(
  db: Db,
  a: {
    workspaceId: string;
    documentId?: string | null;
    actorId: string | null;
    kind: ActivityItem['kind'];
    detail?: string | null;
  },
): Promise<void> {
  await db.insert(activity).values({
    workspaceId: a.workspaceId,
    documentId: a.documentId ?? null,
    actorId: a.actorId,
    kind: a.kind,
    detail: a.detail ?? null,
  });
}

/** Logs an 'edited' entry at most once per actor per document per 10 minutes. */
export async function logEdit(
  db: Db,
  workspaceId: string,
  documentId: string,
  actorId: string,
): Promise<void> {
  const since = new Date(Date.now() - 10 * 60 * 1000);
  const recent = await db
    .select({ id: activity.id })
    .from(activity)
    .where(
      and(
        eq(activity.documentId, documentId),
        eq(activity.actorId, actorId),
        eq(activity.kind, 'edited'),
        gt(activity.createdAt, since),
      ),
    )
    .orderBy(desc(activity.createdAt))
    .limit(1);
  if (!recent.length) await logActivity(db, { workspaceId, documentId, actorId, kind: 'edited' });
}
