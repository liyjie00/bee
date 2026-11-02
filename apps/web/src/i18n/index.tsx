import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { en, type MessageKey } from './en';
import { zhCN } from './zh-CN';
import { ago as agoFn } from '../lib/time';

export type Lang = 'en' | 'zh-CN';
export type T = (key: MessageKey, vars?: Record<string, string | number>) => string;

const DICTS: Record<Lang, Record<MessageKey, string>> = { en, 'zh-CN': zhCN };
const KEY = 'bee-lang';

export function format(lang: Lang, key: MessageKey, vars?: Record<string, string | number>): string {
  const s = DICTS[lang][key] ?? en[key] ?? key;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** English is the default; the choice is remembered per browser. */
function initialLang(): Lang {
  try {
    return localStorage.getItem(KEY) === 'zh-CN' ? 'zh-CN' : 'en';
  } catch {
    return 'en';
  }
}

interface I18n {
  lang: Lang;
  t: T;
  setLang(l: Lang): void;
}
const Ctx = createContext<I18n>({ lang: 'en', t: (k, v) => format('en', k, v), setLang() {} });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    try {
      localStorage.setItem(KEY, l);
    } catch {
      /* private mode */
    }
  }, []);
  const value = useMemo<I18n>(() => ({ lang, setLang, t: (k, v) => format(lang, k, v) }), [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);
export const useT = () => useContext(Ctx).t;
export type { MessageKey };

/** Convenience hook: relative time bound to the current language. */
export function useAgo() {
  const { t, lang } = useI18n();
  return (iso: string) => agoFn(t, iso, lang);
}
