import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { documentVersions, documents, type Db } from '@bee/db';
import { can, type VersionDTO } from '@bee/shared';
import { docAccess, requireDocRole } from '../lib/access.js';
import { logActivity } from '../lib/activity.js';
import { contentJSON } from '../lib/content.js';
import { badRequest, HttpError, notFound } from '../lib/errors.js';
import { loadUserRefs, refOr } from '../lib/dto.js';
import { idParams, parse } from '../lib/validate.js';
import { requireUser } from './auth.js';

type VersionRow = typeof documentVersions.$inferSelect;
const versionMeta = {
  id: documentVersions.id,
  documentId: documentVersions.documentId,
  label: documentVersions.label,
  kind: documentVersions.kind,
  authorIds: documentVersions.authorIds,
  createdById: documentVersions.createdById,
  createdAt: documentVersions.createdAt,
};
type VersionMeta = Omit<VersionRow, 'snapshot'>;

export async function versionDTOs(db: Db, rows: VersionMeta[]): Promise<VersionDTO[]> {
  const refs = await loadUserRefs(
    db,
    rows.flatMap((r) => [...r.authorIds, r.createdById]),
  );
  return rows.map((r) => {
    const ids = r.authorIds.length ? r.authorIds : r.createdById ? [r.createdById] : [];
    return {
      id: r.id,
      documentId: r.documentId,
      label: r.label,
      kind: r.kind,
      authors: ids.map((id) => refOr(refs, id)),
      createdAt: r.createdAt.toISOString(),
    };
  });
}

/** Stores a snapshot unless it is byte-identical to the latest one. */
export async function insertVersion(
  db: Db,
  v: {
    documentId: string;
    snapshot: Buffer;
    kind: VersionRow['kind'];
    label?: string | null;
    authorIds: string[];
    createdById: string | null;
  },
): Promise<VersionMeta | null> {
  if (v.kind === 'auto') {
    const [last] = await db
      .select({ snapshot: documentVersions.snapshot })
      .from(documentVersions)
      .where(eq(documentVersions.documentId, v.documentId))
      .orderBy(desc(documentVersions.createdAt))
      .limit(1);
    if (last && Buffer.compare(last.snapshot, v.snapshot) === 0) return null;
  }
  const [row] = await db
    .insert(documentVersions)
    .values({
      documentId: v.documentId,
      snapshot: v.snapshot,
      kind: v.kind,
      label: v.label ?? null,
      authorIds: v.authorIds,
      createdById: v.createdById,
    })
    .returning(versionMeta);
  return row!;
}

const versionParams = z.object({ id: z.uuid(), vid: z.uuid() });

export async function versionRoutes(app: FastifyInstance) {
  const { db, config } = app;

  const loadVersion = async (documentId: string, vid: string) => {
    const [v] = await db
      .select()
      .from(documentVersions)
      .where(and(eq(documentVersions.id, vid), eq(documentVersions.documentId, documentId)));
    if (!v) throw notFound('Version not found');
    return v;
  };

  app.get('/documents/:id/versions', async (req) => {
    const { id } = parse(idParams, req.params);
    await docAccess(db, {
      userId: req.user?.id ?? null,
      documentId: id,
      shareToken: req.shareToken,
    });
    const rows = await db
      .select(versionMeta)
      .from(documentVersions)
      .where(eq(documentVersions.documentId, id))
      .orderBy(desc(documentVersions.createdAt))
      .limit(500);
    return { versions: await versionDTOs(db, rows) };
  });

  app.post('/documents/:id/versions', async (req, reply) => {
    const user = requireUser(req);
    const { id } = parse(idParams, req.params);
    const { label } = parse(z.object({ label: z.string().trim().max(200).optional() }), req.body);
    const a = await requireDocRole(
      db,
      { userId: user.id, documentId: id },
      can.edit,
      'You cannot edit this document',
    );
    if (!a.doc.ydocState) throw badRequest('The document is empty');
    const v = await insertVersion(db, {
      documentId: id,
      snapshot: a.doc.ydocState,
      kind: 'manual',
      label: label || null,
      authorIds: [user.id],
      createdById: user.id,
    });
    await logActivity(db, {
      workspaceId: a.doc.workspaceId,
      documentId: id,
      actorId: user.id,
      kind: 'version',
      detail: label ?? null,
    });
    return reply.status(201).send({ version: (await versionDTOs(db, [v!]))[0] });
  });

  /** Latest persisted live state (lags the collab server by a few seconds at most). */
  app.get('/documents/:id/versions/current', async (req) => {
    const { id } = parse(idParams, req.params);
    const a = await docAccess(db, {
      userId: req.user?.id ?? null,
      documentId: id,
      shareToken: req.shareToken,
    });
    const refs = await loadUserRefs(db, [a.doc.lastEditedById]);
    const version: VersionDTO = {
      id: 'current',
      documentId: id,
      label: null,
      kind: 'auto',
      authors: a.doc.lastEditedById ? [refOr(refs, a.doc.lastEditedById)] : [],
      createdAt: (a.doc.contentUpdatedAt ?? a.doc.updatedAt).toISOString(),
    };
    if (a.doc.type !== 'doc' || !a.doc.ydocState) return { version, content: null, text: '' };
    return { version, ...contentJSON(a.doc.ydocState) };
  });

  app.get('/documents/:id/versions/:vid', async (req) => {
    const { id, vid } = parse(versionParams, req.params);
    const a = await docAccess(db, {
      userId: req.user?.id ?? null,
      documentId: id,
      shareToken: req.shareToken,
    });
    const v = await loadVersion(id, vid);
    const { snapshot, ...meta } = v;
    const [dto] = await versionDTOs(db, [meta]);
    if (a.doc.type !== 'doc') return { version: dto, content: null, text: '' };
    return { version: dto, ...contentJSON(snapshot) };
  });

  /** Raw Yjs snapshot, for clients that want to diff or render it themselves. */
  app.get('/documents/:id/versions/:vid/state', async (req, reply) => {
    const { id, vid } = parse(versionParams, req.params);
    await docAccess(db, {
      userId: req.user?.id ?? null,
      documentId: id,
      shareToken: req.shareToken,
    });
    const v = await loadVersion(id, vid);
    return reply.header('content-type', 'application/octet-stream').send(v.snapshot);
  });

  app.patch('/documents/:id/versions/:vid', async (req) => {
    const user = requireUser(req);
    const { id, vid } = parse(versionParams, req.params);
    const { label } = parse(z.object({ label: z.string().trim().max(200).nullable() }), req.body);
    await requireDocRole(db, { userId: user.id, documentId: id }, can.edit);
    await loadVersion(id, vid);
    const [row] = await db
      .update(documentVersions)
      .set({ label: label || null, kind: label ? 'manual' : undefined })
      .where(eq(documentVersions.id, vid))
      .returning(versionMeta);
    return { version: (await versionDTOs(db, [row!]))[0] };
  });

  /**
   * Restore: save the current state as a 'restore' version, then ask the collab
   * server to apply the old snapshot as a normal edit (it owns the live doc).
   */
  app.post('/documents/:id/versions/:vid/restore', async (req) => {
    const user = requireUser(req);
    const { id, vid } = parse(versionParams, req.params);
    const a = await requireDocRole(
      db,
      { userId: user.id, documentId: id },
      can.edit,
      'You cannot edit this document',
    );
    const v = await loadVersion(id, vid);
    const [cur] = await db
      .select({ s: documents.ydocState })
      .from(documents)
      .where(eq(documents.id, id));
    let saved: VersionMeta | null = null;
    if (cur?.s) {
      saved = await insertVersion(db, {
        documentId: id,
        snapshot: cur.s,
        kind: 'restore',
        // Unlabelled: clients show the localized name for the 'restore' kind.
        label: null,
        authorIds: [user.id],
        createdById: user.id,
      });
    }
    let res: Response;
    try {
      res = await fetch(`${config.collabInternalUrl}/internal/documents/${id}/restore`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-collab-secret': config.collabSecret,
          'x-user-id': user.id,
        },
        body: new Uint8Array(v.snapshot),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      req.log.error({ err }, 'collab restore failed');
      throw new HttpError(
        503,
        'collab_unavailable',
        'The collaboration server is unavailable, try again',
      );
    }
    if (!res.ok) {
      req.log.error({ status: res.status }, 'collab restore rejected');
      throw new HttpError(502, 'restore_failed', 'Restore failed');
    }
    await logActivity(db, {
      workspaceId: a.doc.workspaceId,
      documentId: id,
      actorId: user.id,
      kind: 'restored',
      detail: v.id,
    });
    const [dto] = await versionDTOs(db, [saved ?? ({ ...v, snapshot: undefined } as VersionMeta)]);
    return { version: dto };
  });
}
