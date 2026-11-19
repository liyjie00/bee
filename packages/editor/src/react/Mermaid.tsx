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

// Lazy-loaded; the strict security level sanitizes the output.
/** The diagram's own width in px, from the SVG's viewBox (Mermaid sizes it with width="100%"). */
function naturalWidth(svg: string): number | null {
  const m = /viewBox="[\d.-]+[ ,]+[\d.-]+[ ,]+([\d.]+)/.exec(svg);
  const w = m ? Number(m[1]) : NaN;
  return w > 0 ? w : null;
}

/** Renders Mermaid source to SVG. `onNaturalWidth` reports the diagram's own width once rendered. */
export function MermaidPreview({ code, onNaturalWidth }: { code: string; onNaturalWidth?: (px: number | null) => void }) {
  const id = `bee-mermaid-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const t = useMessages();
  const ctx = useBeeEditorContext();
  const theme = useTheme(ctx?.theme);
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
          onNaturalWidth?.(naturalWidth(result.svg));
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
  const open = ctx?.openLightbox;
  return (
    <div
      className={`bee-mermaid${open ? ' is-zoomable' : ''}`}
      title={open ? t.viewImage : undefined}
      onClick={open ? () => open({ svg }) : undefined}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
