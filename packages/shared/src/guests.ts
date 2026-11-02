/**
 * Guest comments: anonymous visitors of a public share link with guest comments on
 * may comment under a nickname, without an account.
 */

export const GUEST_NAME_MAX = 40;
/** Guests get a shorter comment limit than members. */
export const GUEST_COMMENT_MAX = 2000;

const GUEST_COLORS = ['#7b8375', '#8a7a68', '#6f7f8f', '#8c7086', '#6d8a7c', '#857b5c'];

/** Stable muted avatar color for a guest nickname. */
export function guestColor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return GUEST_COLORS[h % GUEST_COLORS.length]!;
}
