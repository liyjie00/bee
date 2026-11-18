/* Small building blocks of the ticket screens: type / priority / status marks and pickers. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Priority, ProjectDTO, StatusDTO, TicketType } from '@bee/shared';
import { Avatar } from '../components/Menu';
import { Icon } from '../components/Icon';
import { useT, type MessageKey } from '../i18n';
import type { UserRef } from '../api/types';

const TYPE_COLOR: Record<TicketType, string> = {
  epic: '#7c3aed',
  story: '#1e6b2a',
  task: '#3b7dd8',
  bug: '#c2410c',
  subtask: '#5f8fd6',
};
const TYPE_PATH: Record<TicketType, ReactNode> = {
  epic: <path d="M9 2L4 9h4l-1 5 5-7H8z" />,
  story: <path d="M5 3h6v10l-3-2.5L5 13z" />,
  task: <path d="M4 8.5l3 3 5-6" />,
  bug: <circle cx="8" cy="8" r="2.2" />,
  subtask: <path d="M5 4v5h6" />,
};

export const typeKey = (t: TicketType) => `tk.type.${t}` as MessageKey;
export const priorityKey = (p: Priority) => `tk.priority.${p}` as MessageKey;

export function TypeIcon({ type, size = 14 }: { type: TicketType; size?: number }) {
  const t = useT();
  return (
    <span
      className={'tk-type' + (type === 'bug' ? ' round' : '')}
      style={{ background: TYPE_COLOR[type], width: `${size / 16}rem`, height: `${size / 16}rem` }}
      title={t(typeKey(type))}
      role="img"
      aria-label={t(typeKey(type))}
    >
      <svg viewBox="0 0 16 16" aria-hidden="true">
        {TYPE_PATH[type]}
      </svg>
    </span>
  );
}

const PR_BARS: Record<Priority, number> = { none: 0, low: 1, medium: 2, high: 3, urgent: 3 };
export function PriorityIcon({ priority }: { priority: Priority }) {
  const t = useT();
  if (priority === 'urgent')
    return (
      <span className="tk-urgent" title={t('tk.priority.urgent')}>
        {t('tk.priority.urgent')}
      </span>
    );
  const n = PR_BARS[priority];
  return (
    <span
      className="tk-pr"
      role="img"
      aria-label={t(priorityKey(priority))}
      title={t(priorityKey(priority))}
    >
      {[5, 8, 11].map((h, i) => (
        <i key={i} className={i < n ? 'on' : ''} style={{ height: `${h / 16}rem` }} />
      ))}
    </span>
  );
}

export function StatusDot({
  status,
}: {
  status: Pick<StatusDTO, 'color' | 'category'> | undefined;
}) {
  if (!status) return <span className="tk-dot" />;
  if (status.category === 'todo')
    return <span className="tk-dot ring" style={{ borderColor: status.color }} />;
  if (status.category === 'doing')
    return (
      <span
        className="tk-dot half"
        style={{
          borderColor: status.color,
          background: `linear-gradient(90deg, ${status.color} 50%, transparent 50%)`,
        }}
      />
    );
  return <span className="tk-dot" style={{ background: status.color }} />;
}

export function Points({ value }: { value: number | null | undefined }) {
  if (value === null || value === undefined) return null;
  return <span className="tk-pts">{value}</span>;
}

export function UserChip({ user, sm = true }: { user: UserRef | null | undefined; sm?: boolean }) {
  const t = useT();
  if (!user)
    return (
      <span className="tk-noone" title={t('tk.unassigned')} aria-label={t('tk.unassigned')}>
        ?
      </span>
    );
  return <Avatar name={user.name} color={user.color} url={user.avatarUrl} sm={sm} />;
}

export function ProjectTile({
  project,
  size = 18,
}: {
  project: Pick<ProjectDTO, 'key' | 'color'>;
  size?: number;
}) {
  return (
    <span
      className="tk-tile"
      style={{
        background: project.color,
        width: `${size / 16}rem`,
        height: `${size / 16}rem`,
        fontSize: `${(size * 0.5) / 16}rem`,
      }}
      aria-hidden="true"
    >
      {project.key[0]}
    </span>
  );
}

export interface PickOption {
  id: string;
  label: string;
  icon?: ReactNode;
  hint?: string;
  /** extra words to match when searching */
  keywords?: string;
}

/**
 * A floating list of options near an anchor element: single choice (closes on pick) or
 * multiple (checkboxes). Searchable when it has many options.
 */
export function Picker({
  anchor,
  options,
  value,
  multi,
  onPick,
  onClose,
  search,
  placeholder,
  footer,
}: {
  anchor: HTMLElement | null;
  options: PickOption[];
  value?: string | string[] | null;
  multi?: boolean;
  onPick(id: string): void;
  onClose(): void;
  search?: boolean;
  placeholder?: string;
  footer?: ReactNode;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState('');
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const [active, setActive] = useState(0);
  useLayoutEffect(() => {
    const a = anchor?.getBoundingClientRect();
    const r = ref.current?.getBoundingClientRect();
    if (!a || !r) return;
    const left = Math.max(8, Math.min(a.left, innerWidth - r.width - 8));
    const below = a.bottom + 4;
    const top = below + r.height > innerHeight - 8 ? Math.max(8, a.top - r.height - 4) : below;
    setPos({ left, top });
  }, [anchor, q]);
  useEffect(() => {
    const down = (e: MouseEvent) =>
      !ref.current?.contains(e.target as Node) && !anchor?.contains(e.target as Node) && onClose();
    const key = (e: KeyboardEvent) => e.key === 'Escape' && (e.stopPropagation(), onClose());
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key, true);
    return () => {
      document.removeEventListener('mousedown', down);
      document.removeEventListener('keydown', key, true);
    };
  }, [onClose, anchor]);
  const shown = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s
      ? options.filter((o) => (o.label + ' ' + (o.keywords ?? '')).toLowerCase().includes(s))
      : options;
  }, [q, options]);
  const selected = (id: string) => (Array.isArray(value) ? value.includes(id) : value === id);
  const pick = (o: PickOption) => {
    onPick(o.id);
    if (!multi) onClose();
  };
  return (
    <div
      className="tk-picker"
      ref={ref}
      style={pos}
      role="listbox"
      aria-multiselectable={multi || undefined}
    >
      {(search ?? options.length > 8) && (
        <input
          className="tk-picker-q"
          autoFocus
          value={q}
          placeholder={placeholder ?? t('tk.search')}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, shown.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter' && shown[active]) {
              e.preventDefault();
              pick(shown[active]!);
            }
          }}
        />
      )}
      <div className="tk-picker-list">
        {shown.map((o, i) => (
          <button
            key={o.id}
            role="option"
            aria-selected={selected(o.id)}
            className={(i === active ? 'act ' : '') + (selected(o.id) ? 'sel' : '')}
            onMouseEnter={() => setActive(i)}
            onClick={() => pick(o)}
          >
            {multi && (
              <span className={'ctx-box' + (selected(o.id) ? ' on' : '')}>
                {selected(o.id) && <Icon name="check" size={11} />}
              </span>
            )}
            {o.icon}
            <span className="lbl">{o.label}</span>
            {o.hint && <small>{o.hint}</small>}
            {!multi && selected(o.id) && <Icon name="check" size={12} />}
          </button>
        ))}
        {shown.length === 0 && <p className="tk-picker-empty">{t('tk.noMatches')}</p>}
      </div>
      {footer}
    </div>
  );
}

/** State helper: which picker is open and where. */
export function usePicker<K extends string>() {
  const [open, setOpen] = useState<{ key: K; el: HTMLElement } | null>(null);
  return {
    open,
    toggle: (key: K, el: HTMLElement) => setOpen((o) => (o?.key === key ? null : { key, el })),
    close: () => setOpen(null),
  };
}

export const fmtMinutes = (m: number | null | undefined) => {
  if (!m) return '';
  const h = Math.floor(m / 60);
  const r = m % 60;
  return h && r ? `${h}h ${r}m` : h ? `${h}h` : `${r}m`;
};

/** "2h 30m", "90m", "1.5h", "1d" (8h) → minutes. */
export function parseMinutes(s: string): number | null {
  const str = s.trim().toLowerCase();
  if (!str) return null;
  let total = 0;
  let hit = false;
  for (const m of str.matchAll(/(\d+(?:\.\d+)?)\s*(d|h|m)?/g)) {
    hit = true;
    const n = Number(m[1]);
    total += m[2] === 'd' ? n * 480 : m[2] === 'm' ? n : n * 60;
  }
  return hit ? Math.round(total) : null;
}

export const today = () => new Date().toISOString().slice(0, 10);

/** Short local date, e.g. "Nov 21" / "11月21日". */
export function fmtDate(d: string | null | undefined, lang: string): string {
  if (!d) return '';
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString(lang === 'zh-CN' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
  });
}
