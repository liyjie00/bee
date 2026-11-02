/** URL helpers shared by api and web. */

export const SESSION_COOKIE = 'bee_session';

/** Fragment used for block anchor links: /d/<docId>#b-<blockId> */
export const BLOCK_FRAGMENT_PREFIX = 'b-';

export function documentPath(documentId: string, blockId?: string): string {
  return `/d/${documentId}${blockId ? `#${BLOCK_FRAGMENT_PREFIX}${blockId}` : ''}`;
}

export function shareLinkPath(token: string, blockId?: string): string {
  return `/s/${token}${blockId ? `#${BLOCK_FRAGMENT_PREFIX}${blockId}` : ''}`;
}

/** Extracts the block id from a URL hash like "#b-abc123", or null. */
export function parseBlockFragment(hash: string): string | null {
  const h = hash.startsWith('#') ? hash.slice(1) : hash;
  return h.startsWith(BLOCK_FRAGMENT_PREFIX) && h.length > BLOCK_FRAGMENT_PREFIX.length
    ? h.slice(BLOCK_FRAGMENT_PREFIX.length)
    : null;
}
