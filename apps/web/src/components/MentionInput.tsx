import { useEffect, useRef, useState, type InputHTMLAttributes, type KeyboardEvent } from 'react';
import type { UserRef } from '../api/types';
import { useT } from '../i18n';
import { Avatar } from './Menu';

export type Person = UserRef & { email: string };
export type LoadPeople = (q: string) => Promise<Person[]>;

/** The "@query" being typed right before the caret, if any. */
function mentionAt(value: string, caret: number): { start: number; q: string } | null {
  const m = /(^|\s)@([^\s@]{0,30})$/u.exec(value.slice(0, caret));
  return m ? { start: caret - m[2]!.length - 1, q: m[2]! } : null;
}

/**
 * A comment input that offers people to @mention while "@name" is typed. Enter picks the
 * highlighted person while the list is open, otherwise it is passed on to `onKeyDown`.
 */
export function MentionInput({
  value,
  onValue,
  loadPeople,
  onKeyDown,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string;
  onValue(v: string): void;
  /** absent for guests, who cannot mention */
  loadPeople?: LoadPeople;
}) {
  const t = useT();
  const ref = useRef<HTMLInputElement>(null);
  const [at, setAt] = useState<{ start: number; q: string } | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [sel, setSel] = useState(0);

  useEffect(() => {
    if (!at || !loadPeople) return;
    let live = true;
    const timer = setTimeout(() => {
      loadPeople(at.q).then((p) => {
        if (!live) return;
        setPeople(p.slice(0, 6));
        setSel(0);
      }, () => {});
    }, 120);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [at?.q, loadPeople]);

  const track = (v: string) => {
    const caret = ref.current?.selectionStart ?? v.length;
    setAt(loadPeople ? mentionAt(v, caret) : null);
  };
  const pick = (p: Person) => {
    if (!at) return;
    const caret = at.start + 1 + at.q.length;
    const next = value.slice(0, at.start) + '@' + p.name + ' ' + value.slice(caret);
    onValue(next);
    setAt(null);
    const pos = at.start + p.name.length + 2;
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(pos, pos);
    });
  };
  const open = !!at && !!loadPeople;

  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (open && !e.nativeEvent.isComposing) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (people.length) setSel((i) => (i + (e.key === 'ArrowDown' ? 1 : people.length - 1)) % people.length);
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && people[sel]) {
        e.preventDefault();
        pick(people[sel]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setAt(null);
        return;
      }
    }
    onKeyDown?.(e);
  };

  return (
    <span className="mention-wrap">
      <input
        {...rest}
        ref={ref}
        value={value}
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        onChange={(e) => {
          onValue(e.target.value);
          track(e.target.value);
        }}
        onKeyDown={key}
        onKeyUp={(e) => (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && track(e.currentTarget.value)}
        onBlur={() => setTimeout(() => setAt(null), 150)}
      />
      {open && (
        <div className="mention-pop" role="listbox" aria-label={t('mention.label')}>
          <div className="mention-cap">{t('mention.caption')}</div>
          {people.map((p, i) => (
            <button
              key={p.id}
              role="option"
              aria-selected={i === sel}
              className={i === sel ? 'on' : ''}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setSel(i)}
              onClick={() => pick(p)}
            >
              <Avatar sm name={p.name} color={p.color} />
              <span className="mention-who">
                <span>{p.name}</span>
                <small>{p.email}</small>
              </span>
            </button>
          ))}
          {people.length === 0 && <div className="mention-none">{t('mention.none')}</div>}
        </div>
      )}
    </span>
  );
}
