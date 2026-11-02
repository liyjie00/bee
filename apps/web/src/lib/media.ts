import { useEffect, useState } from 'react';

/** Phone layout: matches the 640px breakpoint in styles.css. */
export const PHONE_QUERY = '(max-width: 640px)';

export function useMediaQuery(query: string): boolean {
  const [on, setOn] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const mq = matchMedia(query);
    const change = () => setOn(mq.matches);
    change();
    mq.addEventListener('change', change);
    return () => mq.removeEventListener('change', change);
  }, [query]);
  return on;
}

/**
 * Height of whatever covers the bottom of the layout viewport (the on-screen keyboard), so fixed
 * bars can sit on top of it. iOS keeps the layout viewport full height under the keyboard.
 */
export function useKeyboardInset(enabled: boolean): number {
  const [inset, setInset] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    if (!enabled || !vv) return setInset(0);
    const update = () => setInset(Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop)));
    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, [enabled]);
  return inset;
}
