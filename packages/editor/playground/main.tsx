/* Dev playground: two users on one document, plus comments and a whiteboard. */
import { StrictMode, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BeeEditor, BeeWhiteboard, blockIdFromHash, type CommentAnchor, type Editor, type Locale } from '../src/index.js';
import { editorToMarkdown } from '../src/react/markdown-paste.js';
import '../src/styles.css';
import './playground.css';

const COLLAB_URL = 'ws://127.0.0.1:18234/collab';
const params = new URLSearchParams(location.search);
const DOC = params.get('doc') ?? 'playground-doc';

interface Thread {
  id: string;
  anchor: CommentAnchor;
  text: string;
  resolved: boolean;
}

function Pane({ name, role, color, locale, threads, setThreads, active, setActive, onEditor }: {
  name: string;
  role: 'editor' | 'commenter' | 'viewer';
  color: string;
  locale: Locale;
  threads: Thread[];
  setThreads: (fn: (t: Thread[]) => Thread[]) => void;
  active: string | null;
  setActive: (id: string | null) => void;
  onEditor?: (e: Editor) => void;
}) {
  const [status, setStatus] = useState('connecting');
  const [presence, setPresence] = useState<string[]>([]);
  const user = useMemo(() => ({ id: name.toLowerCase(), name, color }), [name, color]);
  const comments = useMemo(() => threads.map((t) => ({ id: t.id, anchor: t.anchor, resolved: t.resolved })), [threads]);
  return (
    <section className="pane" data-testid={`pane-${name}`}>
      <header>
        <b>{name}</b> · {role} · <span data-testid={`status-${name}`}>{status}</span> · present: {presence.join(', ')}
      </header>
      <BeeEditor
        documentId={DOC}
        collabUrl={COLLAB_URL}
        shareToken={`${role}:${user.id}`}
        user={user}
        locale={locale}
        editable={role === 'editor'}
        canComment={role !== 'viewer'}
        comments={comments}
        activeCommentId={active}
        onCommentClick={setActive}
        onCreateComment={(anchor) => {
          const text = window.prompt('Comment') ?? '';
          if (!text) return;
          const id = `c${Date.now()}`;
          setThreads((t) => [...t, { id, anchor, text, resolved: false }]);
          setActive(id);
        }}
        uploadImage={async (file) => URL.createObjectURL(file)}
        createWhiteboard={async () => ({ documentId: `wb-${Math.random().toString(36).slice(2, 8)}` })}
        onOpenWhiteboard={(id) => window.open(`?board=${id}`, '_blank')}
        initialBlockId={blockIdFromHash(location.hash)}
        onBlockMissing={(id) => console.warn('block missing', id)}
        onStatus={setStatus}
        onPresence={(users) => setPresence(users.map((u) => u.name))}
        cursorIdleMs={Number(params.get('idleMs')) || undefined}
        onReady={(e) => {
          ((window as unknown as { editors: Record<string, Editor> }).editors ??= {})[name] = e;
          onEditor?.(e);
        }}
      />
    </section>
  );
}

function App() {
  const [threads, setThreads] = useState<Thread[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [locale, setLocale] = useState<Locale>('en');
  const [md, setMd] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const board = params.get('board');

  if (board) {
    return (
      <div style={{ height: '100vh' }}>
        <BeeWhiteboard documentId={board} collabUrl={COLLAB_URL} shareToken="editor:alice" user={{ id: 'alice', name: 'Alice', color: '#3b7dd8' }} editable />
      </div>
    );
  }

  return (
    <div className="app">
      <div className="toolbar">
        <button onClick={() => setLocale(locale === 'en' ? 'zh-CN' : 'en')}>locale: {locale}</button>
        <button onClick={() => editor && setMd(editorToMarkdown(editor))}>export markdown</button>
      </div>
      <div className="panes">
        <Pane name="Alice" role="editor" color="#3b7dd8" locale={locale} threads={threads} setThreads={setThreads} active={active} setActive={setActive} onEditor={setEditor} />
        <Pane name="Kai" role={(params.get('second') as 'editor') ?? 'commenter'} color="#c2410c" locale={locale} threads={threads} setThreads={setThreads} active={active} setActive={setActive} />
      </div>
      <aside className="threads">
        {threads.map((t) => (
          <div key={t.id} className={t.id === active ? 'thread active' : 'thread'} onClick={() => setActive(t.id)}>
            <blockquote>{t.anchor.quote}</blockquote>
            <p>{t.text}</p>
            <button onClick={() => setThreads((all) => all.map((x) => (x.id === t.id ? { ...x, resolved: !x.resolved } : x)))}>
              {t.resolved ? 'reopen' : 'resolve'}
            </button>
          </div>
        ))}
        {md && <pre data-testid="markdown">{md}</pre>}
      </aside>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
