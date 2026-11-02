// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Y from 'yjs';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import { CursorActivity, IdleCollaborationCaret } from '../src/react/caret-idle.js';

describe('CursorActivity', () => {
  it('counts a client as fresh from first sight and idle after the threshold', () => {
    let now = 0;
    const activity = new CursorActivity(() => now);
    activity.observe(1, { anchor: 1, head: 1 });
    now = 999;
    expect(activity.isIdle(1, 1000)).toBe(false);
    now = 1000;
    expect(activity.isIdle(1, 1000)).toBe(true);
  });

  it('resets on movement but not on an unchanged cursor', () => {
    let now = 0;
    const activity = new CursorActivity(() => now);
    activity.observe(1, { anchor: 1, head: 1 });
    now = 900;
    activity.observe(1, { anchor: 1, head: 1 });
    now = 1000;
    expect(activity.isIdle(1, 1000)).toBe(true);
    activity.observe(1, { anchor: 2, head: 2 });
    expect(activity.isIdle(1, 1000)).toBe(false);
  });

  it('treats unknown clients as not idle', () => {
    const activity = new CursorActivity(() => 100);
    expect(activity.isIdle(7, 10)).toBe(false);
  });

  it('keeps a client idle when it reappears with the same cursor', () => {
    let now = 0;
    const activity = new CursorActivity(() => now);
    activity.observe(1, { anchor: 1, head: 1 });
    now = 2000;
    // e.g. the client timed out of awareness and its next heartbeat re-added it.
    activity.observe(1, { anchor: 1, head: 1 });
    expect(activity.isIdle(1, 1000)).toBe(true);
  });
});

describe('IdleCollaborationCaret', () => {
  const IDLE = 60_000;
  let editors: Editor[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    editors = [];
  });
  afterEach(() => {
    editors.forEach((e) => e.destroy());
    vi.useRealTimers();
  });

  // Minimal stand-in for y-protocols awareness: all peers share one state map, and
  // 'change' fires on every peer only when a state really changed.
  const states = new Map<number, Record<string, unknown>>();
  const peers: FakeAwareness[] = [];
  class FakeAwareness {
    states = states;
    private listeners = new Set<(e: { added: number[]; updated: number[]; removed: number[] }) => void>();
    constructor(public clientID: number) {
      states.set(clientID, {});
      peers.push(this);
    }
    getStates() {
      return states;
    }
    getLocalState() {
      return states.get(this.clientID) ?? null;
    }
    setLocalStateField(field: string, value: unknown) {
      const prev = states.get(this.clientID) ?? {};
      if (JSON.stringify(prev[field]) === JSON.stringify(value)) return;
      states.set(this.clientID, { ...prev, [field]: value });
      peers.forEach((p) => p.listeners.forEach((fn) => fn({ added: [], updated: [this.clientID], removed: [] })));
    }
    on(event: string, fn: (e: { added: number[]; updated: number[]; removed: number[] }) => void) {
      if (event === 'change') this.listeners.add(fn);
    }
    off(_event: string, fn: (e: { added: number[]; updated: number[]; removed: number[] }) => void) {
      this.listeners.delete(fn);
    }
  }

  function peer(name: string) {
    const ydoc = new Y.Doc();
    const awareness = new FakeAwareness(ydoc.clientID);
    const editor = new Editor({
      element: document.body.appendChild(document.createElement('div')),
      extensions: [
        StarterKit.configure({ undoRedo: false }),
        Collaboration.configure({ document: ydoc, field: 'default' }),
        IdleCollaborationCaret.configure({ provider: { awareness }, user: { name, color: '#3b7dd8' }, idleMs: IDLE }),
      ],
    });
    editors.push(editor);
    return { ydoc, awareness, editor };
  }

  it('hides a remote caret after the idle threshold and shows it again on movement', () => {
    const a = peer('Alice');
    const b = peer('Kai');
    // ySyncPlugin binds the documents on a timeout.
    vi.advanceTimersByTime(0);
    // Wire the documents both ways, as the provider would.
    a.ydoc.on('update', (u: Uint8Array, origin: unknown) => origin !== 'b' && Y.applyUpdate(b.ydoc, u, 'a'));
    b.ydoc.on('update', (u: Uint8Array, origin: unknown) => origin !== 'a' && Y.applyUpdate(a.ydoc, u, 'b'));
    a.editor.commands.setContent('<p>Hello collaborative world</p>');

    // Alice places her cursor; awareness carries it to Kai.
    a.editor.view.hasFocus = () => true;
    a.editor.commands.setTextSelection(3);
    // Awareness-driven decoration rebuilds are deferred by y-tiptap's setMeta.
    vi.advanceTimersByTime(0);
    const carets = () => b.editor.view.dom.querySelectorAll('.collaboration-carets__caret').length;
    expect(carets()).toBe(1);

    vi.advanceTimersByTime(IDLE - 1_000);
    expect(carets()).toBe(1);
    vi.advanceTimersByTime(30_000);
    expect(carets()).toBe(0);

    a.editor.commands.setTextSelection(5);
    vi.advanceTimersByTime(0);
    expect(carets()).toBe(1);
  });
});
