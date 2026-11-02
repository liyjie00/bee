import { useEffect, useId, useState } from 'react';
import { useMessages } from './i18n.js';
import { useBeeEditorContext } from './context.js';
import { useTheme } from './theme.js';

type MermaidApi = typeof import('mermaid').default;
let mermaidPromise: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= import('mermaid').then((m) => m.default);
  return mermaidPromise;
}

/** Renders Mermaid source to SVG (lazy-loaded; strict security level sanitizes the output). */
export function MermaidPreview({ code }: { code: string }) {
  const id = `bee-mermaid-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const t = useMessages();
  const theme = useTheme(useBeeEditorContext()?.theme);
  const [svg, setSvg] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const source = code.trim();
    if (!source) {
      setSvg('');
      setError(null);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const mermaid = await loadMermaid();
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: theme === 'dark' ? 'dark' : 'neutral' });
        const result = await mermaid.render(id, source);
        if (!cancelled) {
          setSvg(result.svg);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        // Mermaid leaves an error element behind on failure.
        document.getElementById(`d${id}`)?.remove();
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, id, theme]);

  if (error) return <div className="bee-mermaid-error">{t.mermaidError}{error.split('\n')[0]}</div>;
  if (!svg) return <div className="bee-mermaid-empty">{t.mermaidEmpty}</div>;
  return <div className="bee-mermaid" dangerouslySetInnerHTML={{ __html: svg }} />;
}
