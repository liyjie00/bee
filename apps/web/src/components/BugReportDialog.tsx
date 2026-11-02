import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api/http';
import { useI18n } from '../i18n';
import { useSession } from '../state/session';
import { errMsg, useToast } from '../state/toast';
import { Icon } from './Icon';

const MAX_IMAGES = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

interface Shot {
  file: File;
  url: string;
}

/** "Report a problem": text plus up to five screenshots, sent to the Bee team. */
export function BugReportDialog({ onClose }: { onClose(): void }) {
  const { t, lang } = useI18n();
  const toast = useToast();
  const { session } = useSession();
  const [text, setText] = useState('');
  const [shots, setShots] = useState<Shot[]>([]);
  const [info, setInfo] = useState(true);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const [drag, setDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const shotsRef = useRef(shots);
  shotsRef.current = shots;

  useEffect(() => () => shotsRef.current.forEach((s) => URL.revokeObjectURL(s.url)), []);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && !busy && onClose();
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose, busy]);

  const add = (files: Iterable<File>) => {
    const next = [...shots];
    for (const f of files) {
      if (!f.type.startsWith('image/')) {
        toast(t('bug.notImage'));
        continue;
      }
      if (f.size > MAX_IMAGE_BYTES) {
        toast(t('bug.tooBig', { name: f.name }));
        continue;
      }
      if (next.length >= MAX_IMAGES) {
        toast(t('bug.tooMany'));
        break;
      }
      next.push({ file: f, url: URL.createObjectURL(f) });
    }
    setShots(next);
  };
  const remove = (s: Shot) => {
    URL.revokeObjectURL(s.url);
    setShots((cur) => cur.filter((x) => x !== s));
  };
  const onPaste = (e: ClipboardEvent) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    add(files);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    add(e.dataTransfer.files);
  };

  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const fd = new FormData();
    fd.append('body', text);
    if (info) {
      fd.append(
        'meta',
        JSON.stringify({
          url: location.href,
          userAgent: navigator.userAgent,
          viewport: `${innerWidth}×${innerHeight} @${devicePixelRatio}x`,
          language: lang,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      );
    }
    // Images go after the text fields so the server reads those first.
    shots.forEach((s) => fd.append('images', s.file, s.file.name || 'image.png'));
    try {
      setDone((await api.reportBug(fd)).id);
    } catch (e) {
      toast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const empty = !text.trim();
  return createPortal(
    <div className="scrim bug-scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div
        className={'modal bug' + (drag ? ' drag' : '')}
        role="dialog"
        aria-modal="true"
        aria-labelledby="bugTitle"
        onPaste={onPaste}
        onDragOver={(e) => (e.preventDefault(), setDrag(true))}
        onDragLeave={(e) => e.currentTarget === e.target && setDrag(false)}
        onDrop={onDrop}
      >
        {done === null ? (
          <>
            <div className="mh">
              <button className="ico phone-only bug-back" aria-label={t('common.close')} onClick={onClose}>
                <Icon name="chev" style={{ transform: 'rotate(180deg)' }} />
              </button>
              <div>
                <h3 id="bugTitle">{t('bug.title')}</h3>
                <p className="bug-sub hide-phone">{t('bug.subtitle')}</p>
              </div>
              <button className="ico hide-phone" aria-label={t('common.close')} onClick={onClose}>
                <Icon name="x" />
              </button>
            </div>
            <div className="mb">
              <label className="bug-label" htmlFor="bugText">
                {t('bug.what')}
              </label>
              <textarea
                id="bugText"
                className="field-in bug-text"
                autoFocus
                value={text}
                maxLength={10000}
                placeholder={t('bug.placeholder')}
                onChange={(e) => setText(e.target.value)}
              />
              <div className="bug-shots">
                <div className="bug-shots-head">
                  <span className="bug-label">{t('bug.shots')}</span>
                  <span className="bug-hint">
                    {shots.length}/{MAX_IMAGES}
                    <span className="hide-phone"> · {t('bug.shotsHint')}</span>
                  </span>
                </div>
                <div className="bug-tiles">
                  {shots.map((s) => (
                    <div className="bug-tile" key={s.url}>
                      <img src={s.url} alt={s.file.name} />
                      <button aria-label={t('bug.removeShot')} onClick={() => remove(s)}>
                        <Icon name="x" />
                      </button>
                    </div>
                  ))}
                  {shots.length < MAX_IMAGES && (
                    <button className="bug-tile bug-add" onClick={() => fileInput.current?.click()}>
                      <Icon name="plus" />
                      <span className="hide-phone">{t('bug.addShot')}</span>
                      <span className="phone-only">{t('bug.addShotPhone')}</span>
                    </button>
                  )}
                </div>
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(e) => {
                    add(e.target.files ?? []);
                    e.target.value = '';
                  }}
                />
              </div>
              <label className="bug-info">
                <input type="checkbox" checked={info} onChange={(e) => setInfo(e.target.checked)} />
                <span>{t('bug.info')}</span>
              </label>
            </div>
            <div className="mf">
              <span className="bug-hint hide-phone">{t('bug.replyTo', { email: session?.user.email ?? '' })}</span>
              <div className="spacer" />
              <button className="btn hide-phone" onClick={onClose}>
                {t('common.cancel')}
              </button>
              <button className="btn primary bug-send" disabled={empty || busy} onClick={send}>
                {busy ? t('bug.sending') : t('bug.send')}
              </button>
            </div>
          </>
        ) : (
          <div className="bug-done">
            <span className="bug-ok">
              <Icon name="check" />
            </span>
            <h3 id="bugTitle">{t('bug.thanks')}</h3>
            <p>{t('bug.thanksBody', { id: `#BUG-${String(done).padStart(4, '0')}` })}</p>
            <button className="btn" onClick={onClose}>
              {t('bug.done')}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
