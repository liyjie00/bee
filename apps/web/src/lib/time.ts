import type { T } from '../i18n';

const hm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
export { hm };

/** Relative time used across lists, comments and history. */
export function ago(t: T, iso: string, lang: string, now = Date.now()): string {
  const ts = new Date(iso).getTime();
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 45) return t('time.justNow');
  const m = Math.round(s / 60);
  if (m < 60) return t('time.minutes', { n: m });
  const h = Math.round(m / 60);
  const d = new Date(ts);
  if (h < 24 && d.toDateString() === new Date(now).toDateString()) return t('time.hours', { n: h });
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return t('time.yesterdayAt', { time: hm(d) });
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(lang, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Day bucket label for the version list: Today / Yesterday / Oct 30 */
export function dayLabel(t: T, iso: string, lang: string, now = Date.now()): string {
  const d = new Date(iso);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return t('time.today');
  today.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return t('time.yesterday');
  return d.toLocaleDateString(lang, { month: 'short', day: 'numeric' });
}
