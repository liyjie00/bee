import type { DocFont, DocFontSize, UserPrefs } from '@bee/shared';

const KEY = 'bee-doc-prefs';

const SIZES: Record<DocFontSize, string> = { small: '12.5px', medium: '13.5px', large: '15px' };
const FONTS: Record<DocFont, string> = {
  sans: 'var(--f-body)',
  serif: 'var(--f-serif)',
  mono: 'var(--f-mono)',
};

/**
 * Applies the reader's document font settings as CSS variables read by `.bee-prose`.
 * Cached per browser so index.html can apply them before first paint.
 */
export function applyDocPrefs(prefs: UserPrefs | null | undefined) {
  const s = document.documentElement.style;
  s.setProperty('--doc-font-size', SIZES[prefs?.docFontSize ?? 'medium']);
  s.setProperty('--doc-font', FONTS[prefs?.docFont ?? 'sans']);
  try {
    localStorage.setItem(KEY, JSON.stringify({ size: s.getPropertyValue('--doc-font-size'), font: s.getPropertyValue('--doc-font') }));
  } catch {
    /* private mode */
  }
}
