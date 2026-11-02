import { useSyncExternalStore } from 'react';
import type { MessageKey } from '../i18n/en';

/** One entry in "What's new". Newest first; add new features at the top. */
export interface Feature {
  id: string;
  /** Release day, YYYY-MM-DD. */
  date: string;
  title: MessageKey;
  body: MessageKey;
  /** A link to try it, e.g. the settings section that turns it on. */
  cta?: { label: MessageKey; to: string };
}

export const FEATURES: Feature[] = [
  { id: 'math', date: '2026-11-02', title: 'wn.math', body: 'wn.mathBody' },
  { id: 'mcp', date: '2026-11-02', title: 'wn.mcp', body: 'wn.mcpBody', cta: { label: 'wn.mcpCta', to: '/settings/agents' } },
  { id: 'ai', date: '2026-11-02', title: 'wn.ai', body: 'wn.aiBody' },
  { id: 'sheet', date: '2026-11-02', title: 'wn.sheet', body: 'wn.sheetBody' },
  { id: 'board', date: '2026-11-02', title: 'wn.board', body: 'wn.boardBody' },
  { id: 'mobile', date: '2026-11-02', title: 'wn.mobile', body: 'wn.mobileBody' },
];

/** The home page shows cards for features released in the last this-many days. */
const HOME_DAYS = 45;
const DAY = 86_400_000;

/** Seen / dismissed ids live per browser: losing them only means a card shows again. */
const KEY = 'bee-whats-new';
interface Stored {
  seen: string[];
  dismissed: string[];
}

function load(): Stored {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '') as Partial<Stored>;
    return { seen: Array.isArray(v.seen) ? v.seen : [], dismissed: Array.isArray(v.dismissed) ? v.dismissed : [] };
  } catch {
    return { seen: [], dismissed: [] };
  }
}

interface State extends Stored {
  /** The changelog popover is open (shared so the home page can open the top bar's popover). */
  open: boolean;
}

let state: State = { ...load(), open: false };
const listeners = new Set<() => void>();

function set(next: Partial<State>) {
  state = { ...state, ...next };
  try {
    localStorage.setItem(KEY, JSON.stringify({ seen: state.seen, dismissed: state.dismissed }));
  } catch {
    /* private mode */
  }
  listeners.forEach((l) => l());
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];

export function useWhatsNew() {
  const s = useSyncExternalStore(subscribe, () => state);
  const now = Date.now();
  return {
    open: s.open,
    /** Some feature has not been seen in the changelog yet. */
    unseen: FEATURES.some((f) => !s.seen.includes(f.id)),
    /** Recent features the user has not closed on the home page. */
    cards: FEATURES.filter((f) => !s.dismissed.includes(f.id) && now - Date.parse(f.date) < HOME_DAYS * DAY),
    setOpen(open: boolean) {
      set(open ? { open, seen: union(s.seen, FEATURES.map((f) => f.id)) } : { open });
    },
    dismiss(id: string) {
      set({ dismissed: union(s.dismissed, [id]) });
    },
    dismissAll() {
      set({ dismissed: union(s.dismissed, FEATURES.map((f) => f.id)) });
    },
  };
}

/** Slash-menu blocks to badge "New" until the user has inserted one. */
const SLASH_NEW = ['sheet', 'linkWhiteboard', 'mathBlock', 'mathInline'];
const SLASH_KEY = 'bee-slash-used';

export function newSlashItems(): string[] {
  try {
    const used = JSON.parse(localStorage.getItem(SLASH_KEY) ?? '[]') as string[];
    return SLASH_NEW.filter((id) => !used.includes(id));
  } catch {
    return SLASH_NEW;
  }
}

export function slashItemUsed(id: string) {
  if (!SLASH_NEW.includes(id)) return;
  try {
    const used = JSON.parse(localStorage.getItem(SLASH_KEY) ?? '[]') as string[];
    if (!used.includes(id)) localStorage.setItem(SLASH_KEY, JSON.stringify([...used, id]));
  } catch {
    /* private mode */
  }
}
