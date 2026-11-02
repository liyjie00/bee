import * as Y from 'yjs';

/** Root types Bee uses: rich text fragment, and the whiteboard element/file maps. */
const FRAGMENTS = ['default'];
const MAPS = ['elements', 'files'];

/**
 * Replaces the content of `target` with the content of `snapshot`, as ordinary Yjs operations so
 * connected clients receive the restore like any other edit. Pure Yjs: no schema knowledge needed.
 */
export function replaceDocContent(target: Y.Doc, snapshot: Y.Doc): void {
  target.transact(() => {
    for (const name of FRAGMENTS) {
      const source = snapshot.share.has(name) ? snapshot.getXmlFragment(name) : null;
      if (!source && !target.share.has(name)) continue;
      const dest = target.getXmlFragment(name);
      if (dest.length) dest.delete(0, dest.length);
      if (source?.length) dest.insert(0, source.toArray().map((child) => child.clone() as Y.XmlElement | Y.XmlText));
    }
    for (const name of MAPS) {
      const source = snapshot.share.has(name) ? snapshot.getMap(name) : null;
      if (!source && !target.share.has(name)) continue;
      const dest = target.getMap(name);
      for (const key of [...dest.keys()]) if (!source?.has(key)) dest.delete(key);
      source?.forEach((value, key) => {
        dest.set(key, value instanceof Y.AbstractType ? value.clone() : value);
      });
    }
  }, 'bee:restore');
}
