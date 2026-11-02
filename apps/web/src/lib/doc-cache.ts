import { api } from '../api/http';

/** How long a prefetched (e.g. hovered) document stays usable for opening it. */
const TTL_MS = 15_000;

const states = new Map<string, { at: number; state: Promise<Uint8Array | null> }>();

/** Stored Yjs state, shared with a prefetch still in flight. */
function docState(id: string): Promise<Uint8Array | null> {
  const now = Date.now();
  for (const [k, e] of states) if (now - e.at > TTL_MS) states.delete(k);
  let e = states.get(id);
  if (!e) {
    const state = api.documentState(id);
    // A failed prefetch must not stick: the next open retries.
    state.catch(() => states.get(id)?.state === state && states.delete(id));
    e = { at: now, state };
    states.set(id, e);
  }
  return e.state;
}

/**
 * Starts loading a document's content (hover, focus, or route change) so the editor can render it
 * as soon as it mounts, without waiting for the collab WebSocket.
 */
export function prefetchDoc(id: string): void {
  void docState(id).catch(() => {});
}

/** The pre-sync snapshot for an editor that is opening the document; the next open refetches. */
export function takeDocState(id: string): Promise<Uint8Array | null> {
  const p = docState(id);
  // Not dropped right away: a remount in the same moment (StrictMode) should share the request.
  setTimeout(() => states.get(id)?.state === p && states.delete(id), 1000);
  return p;
}

let hoverTimer: ReturnType<typeof setTimeout> | undefined;

/** Props for a link to a document: prefetch after a short hover (skips a mouse passing over), or on focus. */
export function prefetchProps(id: string) {
  return {
    onMouseEnter: () => {
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => prefetchDoc(id), 80);
    },
    onMouseLeave: () => clearTimeout(hoverTimer),
    onFocus: () => prefetchDoc(id),
  };
}
