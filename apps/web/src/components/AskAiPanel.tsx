import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type PointerEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { AI_PROVIDERS, type AiProvider, type AiSettingsDTO, type AiStreamEvent } from '@bee/shared';
import { aiApi } from '../api/ai';
import { useT, type MessageKey } from '../i18n';
import { renderChatMarkdown } from '../lib/chatMarkdown';
import { errMsg, useToast } from '../state/toast';
import { Icon } from './Icon';

interface ToolStep {
  id: string;
  title: string;
  state: 'running' | 'ok' | 'error';
  summary?: string;
}
interface Edit {
  documentId: string;
  title: string;
  before: string;
  after: string;
  undone?: boolean;
}
interface Msg {
  role: 'user' | 'assistant';
  content: string;
  tools?: ToolStep[];
  /** first "before" and last "after" per edited document */
  edits?: Edit[];
  created?: { documentId: string; title: string }[];
  error?: string;
}

const PROVIDER_LABEL: Record<AiProvider, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic (Claude)',
  xai: 'xAI (Grok)',
  gemini: 'Google (Gemini)',
};
const KEY_PROVIDERS = AI_PROVIDERS.filter((p) => p !== 'openrouter');
const SUGGESTIONS: MessageKey[] = ['ai.suggest.summarize', 'ai.suggest.polish', 'ai.suggest.outline', 'ai.suggest.newDoc'];

const WIDTH_KEY = 'bee.aiPanelWidth';
const clampWidth = (w: number) => Math.round(Math.min(Math.max(w, 300), Math.min(900, innerWidth - 360)));
function savedWidth(): number {
  try {
    const w = Number(localStorage.getItem(WIDTH_KEY));
    return w > 0 ? clampWidth(w) : 380;
  } catch {
    return 380;
  }
}

/** Conversations survive switching documents within this tab. */
const conversations = new Map<string, Msg[]>();

export function AskAiPanel({ documentId, onClose }: { documentId: string; onClose(): void }) {
  const t = useT();
  const toast = useToast();
  const loc = useLocation();
  const [settings, setSettings] = useState<AiSettingsDTO | null>(null);
  const [view, setView] = useState<'chat' | 'settings'>('chat');
  const [msgs, setMsgs] = useState<Msg[]>(() => conversations.get(documentId) ?? []);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(savedWidth);

  /** Drag the left edge to resize; the width is remembered per browser. */
  function startResize(e: PointerEvent<HTMLDivElement>) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let w = startW;
    const move = (ev: globalThis.PointerEvent) => {
      w = clampWidth(startW + startX - ev.clientX);
      setWidth(w);
    };
    const up = () => {
      removeEventListener('pointermove', move);
      removeEventListener('pointerup', up);
      document.body.classList.remove('resizing');
      try {
        localStorage.setItem(WIDTH_KEY, String(w));
      } catch {
        /* private mode */
      }
    };
    document.body.classList.add('resizing');
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  }

  const load = () => aiApi.settings().then(setSettings, (e) => toast(errMsg(e)));
  useEffect(() => {
    load();
    // The OpenRouter sign-in popup reports back here.
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== location.origin || (e.data as { type?: string })?.type !== 'bee-ai-signin') return;
      if ((e.data as { ok: boolean }).ok) {
        toast(t('ai.connectedToast'));
        setView('chat');
        load();
      } else toast(t('ai.signInFailed'));
    };
    addEventListener('message', onMsg);
    return () => removeEventListener('message', onMsg);
  }, []);
  useEffect(() => {
    setMsgs(conversations.get(documentId) ?? []);
  }, [documentId]);
  useEffect(() => {
    conversations.set(documentId, msgs);
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [msgs]);
  useEffect(() => () => abortRef.current?.abort(), []);

  const connected = !!settings?.provider;

  function signIn() {
    const url = aiApi.signInUrl(loc.pathname);
    const w = open(url, 'bee-ai-signin', 'popup,width=520,height=720');
    if (!w) location.assign(url);
  }

  async function send(text: string) {
    text = text.trim();
    if (!text || busy) return;
    const history = [...msgs, { role: 'user' as const, content: text }];
    const reply: Msg = { role: 'assistant', content: '', tools: [], edits: [], created: [] };
    setMsgs([...history, reply]);
    setInput('');
    setBusy(true);
    const ac = new AbortController();
    abortRef.current = ac;
    // Mutate a working copy and publish snapshots, so streamed deltas stay cheap.
    const update = (fn: (m: Msg) => void) => {
      fn(reply);
      setMsgs([...history, { ...reply }]);
    };
    const onEvent = (e: AiStreamEvent) => {
      if (e.type === 'text') update((m) => (m.content += e.delta));
      else if (e.type === 'tool')
        update((m) => {
          m.tools = [...m.tools!, { id: e.id, title: e.title, state: 'running' }];
          // Text after a tool call starts a new paragraph.
          if (m.content && !m.content.endsWith('\n\n')) m.content += '\n\n';
        });
      else if (e.type === 'tool_result')
        update((m) => {
          m.tools = m.tools!.map((s) => (s.id === e.id ? { ...s, state: e.ok ? 'ok' : 'error', summary: e.summary } : s));
          if (e.edit) {
            const prev = m.edits!.find((x) => x.documentId === e.edit!.documentId);
            m.edits = prev
              ? m.edits!.map((x) => (x === prev ? { ...x, after: e.edit!.after, title: e.edit!.title } : x))
              : [...m.edits!, { ...e.edit }];
          }
          if (e.created) m.created = [...m.created!, e.created];
        });
      else if (e.type === 'error') update((m) => (m.error = e.message));
    };
    try {
      await aiApi.chat(
        {
          // Earlier turns go back as text; failed or empty replies are left out.
          messages: history.filter((m) => m.content.trim()).map((m) => ({ role: m.role, content: m.content })),
          documentId,
        },
        onEvent,
        ac.signal,
      );
    } catch (e) {
      if (!ac.signal.aborted) update((m) => (m.error = errMsg(e)));
    } finally {
      if (ac.signal.aborted) update((m) => (m.error = t('ai.stopped')));
      abortRef.current = null;
      setBusy(false);
    }
  }

  async function undo(mi: number, edit: Edit) {
    try {
      const now = await aiApi.markdown(edit.documentId);
      if (now !== edit.after && !confirm(t('ai.undoChanged'))) return;
      await aiApi.editMarkdown(edit.documentId, { mode: 'replace', markdown: edit.before });
      setMsgs((ms) =>
        ms.map((m, i) =>
          i === mi ? { ...m, edits: m.edits!.map((x) => (x.documentId === edit.documentId ? { ...x, undone: true } : x)) } : m,
        ),
      );
      toast(t('ai.undone'));
    } catch (e) {
      toast(errMsg(e));
    }
  }

  return (
    <aside className="panel ai-panel" aria-label={t('ai.panel')} style={{ '--ai-w': `${width}px` } as CSSProperties}>
      <div
        className="ai-resize"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('ai.resize')}
        title={t('ai.resize')}
        onPointerDown={startResize}
        onDoubleClick={() => {
          setWidth(380);
          try {
            localStorage.removeItem(WIDTH_KEY);
          } catch {
            /* private mode */
          }
        }}
      />
      <div className="ptabs">
        <button className={view === 'chat' ? 'on' : ''} onClick={() => setView('chat')}>
          <Icon name="spark" size={14} /> {t('ai.title')}
        </button>
        {connected && (
          <button className={view === 'settings' ? 'on' : ''} onClick={() => setView('settings')}>
            {t('ai.account')}
          </button>
        )}
        <span style={{ marginLeft: 'auto' }} />
        {connected && view === 'chat' && msgs.length > 0 && (
          <button className="ico" style={{ marginBottom: '0.5rem' }} title={t('ai.newChat')} aria-label={t('ai.newChat')} disabled={busy} onClick={() => setMsgs([])}>
            <Icon name="plus" />
          </button>
        )}
        <button className="ico x" style={{ marginLeft: 0 }} aria-label={t('ai.close')} onClick={onClose}>
          <Icon name="x" />
        </button>
      </div>

      {!settings ? (
        <div className="pbody">
          <p className="ai-muted">{t('app.loading')}</p>
        </div>
      ) : !connected || view === 'settings' ? (
        <div className="pbody">
          <AccountView settings={settings} onSignIn={signIn} onChange={(s) => { setSettings(s); if (s.provider && !connected) setView('chat'); }} />
        </div>
      ) : (
        <>
          <div className="pbody ai-body" ref={bodyRef}>
            {msgs.length === 0 && (
              <div className="ai-empty">
                <p>{t('ai.emptyLead')}</p>
                <div className="ai-chips">
                  {SUGGESTIONS.map((k) => (
                    <button key={k} className="btn" onClick={() => void send(t(k))}>
                      {t(k)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {msgs.map((m, i) =>
              m.role === 'user' ? (
                <div key={i} className="ai-msg user">
                  {m.content}
                </div>
              ) : (
                <div key={i} className="ai-msg bot">
                  {m.tools?.map((s) => (
                    <div key={s.id} className={'ai-step ' + s.state} title={s.summary}>
                      <Icon name={s.state === 'error' ? 'x' : s.state === 'ok' ? 'check' : 'clock'} size={12} />
                      <span>{s.title}</span>
                      {s.state === 'error' && s.summary && <small>{s.summary}</small>}
                    </div>
                  ))}
                  {m.content && <div className="ai-text" dangerouslySetInnerHTML={{ __html: renderChatMarkdown(m.content) }} />}
                  {!m.content && !m.error && busy && i === msgs.length - 1 && !m.tools?.some((s) => s.state === 'running') && (
                    <div className="ai-typing" aria-label={t('ai.thinking')}>
                      <i />
                      <i />
                      <i />
                    </div>
                  )}
                  {m.created?.map((c) => (
                    <Link key={c.documentId} className="ai-card" to={`/d/${c.documentId}`}>
                      <Icon name="doc" size={14} />
                      <span>{c.title || t('common.untitled')}</span>
                      <small>{t('ai.created')}</small>
                    </Link>
                  ))}
                  {m.edits?.map((ed) => (
                    <div key={ed.documentId} className="ai-card">
                      <Icon name="pen" size={14} />
                      <span>
                        {ed.documentId === documentId ? t('ai.editedThis') : t('ai.editedOther', { title: ed.title || t('common.untitled') })}
                      </span>
                      {ed.undone ? (
                        <small>{t('ai.undoneTag')}</small>
                      ) : (
                        <button className="btn" disabled={busy} onClick={() => void undo(i, ed)}>
                          <Icon name="restore" size={13} />
                          {t('ai.undo')}
                        </button>
                      )}
                    </div>
                  ))}
                  {m.error && <div className="ai-error">{m.error}</div>}
                </div>
              ),
            )}
          </div>
          <form
            className="ai-input"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void send(input);
            }}
          >
            <textarea
              value={input}
              rows={3}
              placeholder={t('ai.placeholder')}
              aria-label={t('ai.placeholder')}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send(input);
                }
              }}
            />
            <div className="ai-input-row">
              <button type="button" className="ai-model" title={t('ai.changeModel')} onClick={() => setView('settings')}>
                {settings.model ?? t('ai.noModel')}
              </button>
              {busy ? (
                <button type="button" className="btn" onClick={() => abortRef.current?.abort()}>
                  {t('ai.stop')}
                </button>
              ) : (
                <button type="submit" className="btn primary" disabled={!input.trim()}>
                  {t('ai.send')}
                </button>
              )}
            </div>
          </form>
        </>
      )}
    </aside>
  );
}

/** Connect an AI account (OpenRouter sign-in, or an API key) and pick the model. */
function AccountView({ settings, onSignIn, onChange }: { settings: AiSettingsDTO; onSignIn(): void; onChange(s: AiSettingsDTO): void }) {
  const t = useT();
  const toast = useToast();
  const [keyProvider, setKeyProvider] = useState<AiProvider>('openai');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(!settings.provider);
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState<{ id: string; name: string }[] | null>(null);
  const provider = settings.provider;

  useEffect(() => {
    setModels(null);
    if (provider) aiApi.models(provider).then(setModels, (e) => toast(errMsg(e)));
  }, [provider]);
  const modelOptions = useMemo(() => {
    const list = models ?? [];
    return settings.model && !list.some((m) => m.id === settings.model) ? [{ id: settings.model, name: settings.model }, ...list] : list;
  }, [models, settings.model]);

  const run = async (p: Promise<AiSettingsDTO>, ok?: MessageKey) => {
    setSaving(true);
    try {
      onChange(await p);
      if (ok) toast(t(ok));
      return true;
    } catch (e) {
      toast(errMsg(e));
      return false;
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="ai-account">
      {!provider && <p className="ai-lead">{t('ai.connectLead')}</p>}
      {provider && (
        <section>
          <h3>{t('ai.model')}</h3>
          <label className="ai-field">
            <span>{t('ai.provider')}</span>
            <select value={provider} disabled={saving} onChange={(e) => void run(aiApi.update({ provider: e.target.value as AiProvider }))}>
              {settings.connected.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABEL[p]}
                </option>
              ))}
            </select>
          </label>
          <label className="ai-field">
            <span>{t('ai.model')}</span>
            <select value={settings.model ?? ''} disabled={saving || !models} onChange={(e) => void run(aiApi.update({ model: e.target.value }))}>
              {!models && <option value={settings.model ?? ''}>{t('app.loading')}</option>}
              {models &&
                modelOptions.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name === m.id ? m.id : `${m.name} (${m.id})`}
                  </option>
                ))}
            </select>
          </label>
        </section>
      )}

      <section>
        <h3>{t('ai.keysTitle')}</h3>
        <p className="ai-lead">{t('ai.keysLead')}</p>
        {KEY_PROVIDERS.filter((p) => settings.connected.includes(p)).map((p) => (
          <div key={p} className="ai-conn">
            <Icon name="check" size={14} />
            <span>{PROVIDER_LABEL[p]}</span>
            <button className="btn" disabled={saving} onClick={() => void run(aiApi.removeKey(p), 'ai.disconnected')}>
              {t('ai.remove')}
            </button>
          </div>
        ))}
        {showKey ? (
          <form
            className="ai-keyform"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await run(aiApi.setKey(keyProvider, apiKey.trim()), 'ai.connectedToast')) {
                setApiKey('');
                setShowKey(false);
              }
            }}
          >
            <select value={keyProvider} onChange={(e) => setKeyProvider(e.target.value as AiProvider)} aria-label={t('ai.provider')}>
              {KEY_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {PROVIDER_LABEL[p]}
                </option>
              ))}
            </select>
            <input
              className="field-in"
              type="password"
              autoComplete="off"
              placeholder={t('ai.keyPlaceholder')}
              aria-label={t('ai.keyPlaceholder')}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
            <button className="btn primary" type="submit" disabled={saving || apiKey.trim().length < 8}>
              {saving ? t('ai.checking') : t('ai.saveKey')}
            </button>
          </form>
        ) : (
          <button className="btn" onClick={() => setShowKey(true)}>
            {t('ai.addKey')}
          </button>
        )}
        <p className="ai-fine">{t('ai.keysNote')}</p>
      </section>
      <section>
        <h3>{t('ai.signInTitle')}</h3>
        <p className="ai-lead">{t('ai.signInLead')}</p>
        {settings.connected.includes('openrouter') ? (
          <div className="ai-conn">
            <Icon name="check" size={14} />
            <span>{t('ai.signedIn')}</span>
            <button className="btn" disabled={saving} onClick={() => void run(aiApi.removeKey('openrouter'), 'ai.disconnected')}>
              {t('ai.disconnect')}
            </button>
          </div>
        ) : (
          <button className="btn primary ai-signin" onClick={onSignIn}>
            {t('ai.signIn')}
          </button>
        )}
      </section>

    </div>
  );
}
