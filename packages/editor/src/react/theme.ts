import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

function documentTheme(): Theme {
  const forced = document.documentElement.dataset.theme;
  if (forced === 'light' || forced === 'dark') return forced;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * The theme to render embeds (Excalidraw, Mermaid) with: the explicit prop, else the app's
 * `<html data-theme>`, else the OS preference. Updates live when either changes.
 */
export function useTheme(theme?: Theme): Theme {
  const [auto, setAuto] = useState<Theme>(() => (typeof document === 'undefined' ? 'light' : documentTheme()));
  useEffect(() => {
    if (theme) return;
    const update = () => setAuto(documentTheme());
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', update);
    update();
    return () => {
      observer.disconnect();
      media.removeEventListener('change', update);
    };
  }, [theme]);
  return theme ?? auto;
}
