import { isValidCSSStyleValue } from '@tiptap/core';
import CollaborationCaret, { type CollaborationCaretOptions } from '@tiptap/extension-collaboration-caret';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { defaultAwarenessStateFilter, yCursorPlugin, yCursorPluginKey } from '@tiptap/y-tiptap';

/** Remote carets whose cursor/selection has not moved for this long are hidden. */
export const CURSOR_IDLE_MS = 10 * 60 * 1000;

/**
 * Tracks, per remote awareness client, the local time its cursor last changed.
 * Remote clocks are never consulted: a client counts as fresh from the moment it is first seen.
 * Entries are kept when a client drops out of awareness: a background tab's throttled heartbeat
 * makes it time out and reappear with the same cursor, which must not count as a move.
 * Client ids are per page load, so this stays small for the editor's lifetime.
 */
export class CursorActivity {
  private seen = new Map<number, { key: string; movedAt: number }>();

  constructor(private now: () => number = Date.now) {}

  /** Records the client's current cursor; a different value than last time counts as a move. */
  observe(clientId: number, cursor: unknown): void {
    const key = JSON.stringify(cursor ?? null);
    const prev = this.seen.get(clientId);
    if (!prev || prev.key !== key) this.seen.set(clientId, { key, movedAt: this.now() });
  }

  isIdle(clientId: number, idleMs: number): boolean {
    const entry = this.seen.get(clientId);
    return !!entry && this.now() - entry.movedAt >= idleMs;
  }
}

export interface IdleCollaborationCaretOptions extends CollaborationCaretOptions {
  /** Hide a remote caret after its cursor has not moved for this many ms. */
  idleMs: number;
}

const isValidUserColor = (color: unknown): color is string =>
  isValidCSSStyleValue(color as string) && /^#[0-9a-fA-F]{6}$/.test(color as string);

// Mirrors CollaborationCaret's own sanitizing, which it does not export.
const sanitizeUserColor = (user: Record<string, unknown>) => ({
  ...user,
  color: isValidUserColor(user.color) ? user.color : 'transparent',
});

/** CollaborationCaret that hides carets and selections of collaborators who stopped moving. */
export const IdleCollaborationCaret = CollaborationCaret.extend<IdleCollaborationCaretOptions>({
  addOptions() {
    return { ...this.parent!(), idleMs: CURSOR_IDLE_MS };
  },

  addProseMirrorPlugins() {
    // Keep the parent's other plugins (awareness listener); replace its cursor plugin with a filtered one.
    const inherited = this.parent!().filter((plugin) => plugin.spec.key !== yCursorPluginKey);
    const { provider, idleMs } = this.options;
    const awareness = provider.awareness;
    const activity = new CursorActivity();

    const cursors = yCursorPlugin(awareness, {
      awarenessStateFilter: (localId, clientId, state) => {
        if (!defaultAwarenessStateFilter(localId, clientId, state)) return false;
        // Decorations are rebuilt on every awareness change, so observing here never misses a move.
        activity.observe(clientId, state.cursor);
        return !activity.isIdle(clientId, idleMs);
      },
      cursorBuilder: (user) => this.options.render(sanitizeUserColor(user)),
      selectionBuilder: (user) => this.options.selectionRender(sanitizeUserColor(user)),
    });

    // Rebuilds decorations when a caret crosses the idle threshold without any awareness change.
    const idleTimer = new Plugin({
      key: new PluginKey('collaborationCaretIdle'),
      view: (view) => {
        const idleSet = () => {
          const ids: number[] = [];
          awareness.getStates().forEach((state: Record<string, unknown>, clientId: number) => {
            if (clientId !== awareness.clientID && state.cursor != null && activity.isIdle(clientId, idleMs)) ids.push(clientId);
          });
          return ids.join(',');
        };
        let last = idleSet();
        const timer = setInterval(() => {
          const next = idleSet();
          if (next === last || view.isDestroyed) return;
          last = next;
          view.dispatch(view.state.tr.setMeta(yCursorPluginKey, { awarenessUpdated: true }));
        }, Math.min(30_000, Math.max(1_000, idleMs / 4)));
        return { destroy: () => clearInterval(timer) };
      },
    });

    return [...inherited, cursors, idleTimer];
  },
});
