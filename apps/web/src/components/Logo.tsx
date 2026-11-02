import { useId } from 'react';

/**
 * Bee brand marks, inlined so they follow the app theme (--logo-ink / --logo-sting).
 * Geometry matches the approved design/logo/bee-logo.svg; static copies live in public/brand/.
 */
const HONEY = '#e8a317';

function MarkPaths() {
  return (
    <>
      <path d="M12.12 0L24.25 7V21L12.12 28L0 21V7Z" fill={HONEY} />
      <path d="M38.87 0L51 7V21L38.87 28L26.75 21V7Z" fill="var(--logo-ink)" />
      <path d="M25.5 25.47L35.62 31.32V43.01L25.5 48.86L15.37 43.01V31.32Z" fill="none" stroke={HONEY} strokeWidth="4" strokeLinejoin="miter" />
      <rect x="37.37" y="8.05" width="3" height="11.9" fill="var(--logo-sting)" />
    </>
  );
}

/** "bee" built from hexagon strokes; drawn in the 0..140 x 48..104 box. */
function WordPaths() {
  const id = useId().replace(/:/g, '');
  return (
    <>
      <defs>
        <mask id={`${id}m`} maskUnits="userSpaceOnUse" x="-50" y="-50" width="400" height="300">
          <rect x="-50" y="-50" width="400" height="300" fill="#fff" />
          <path d="M8.6 61.8L-2 67.92" stroke="#000" strokeWidth="1.6" strokeLinecap="square" />
          <rect x="90.28" y="80" width="4.5" height="28" fill="#000" />
          <rect x="137.92" y="80" width="4.5" height="28" fill="#000" />
        </mask>
        <clipPath id={`${id}c1`}>
          <path d="M59.96 -100H300V226.92L59.96 88.34Z" />
        </clipPath>
        <clipPath id={`${id}c3`}>
          <path d="M107.6 -100H300V199.42L107.6 88.34Z" />
        </clipPath>
      </defs>
      <g mask={`url(#${id}m)`} fill="none" stroke="var(--logo-ink)" strokeWidth="8" strokeLinejoin="miter" strokeMiterlimit="1.6" strokeLinecap="butt">
        <path d="M4 48V90L21.32 100L38.64 90V70L21.32 60L4 70" />
        <path d="M53.87 90.74L86.28 70L68.96 60L60.3 65" clipPath={`url(#${id}c1)`} />
        <path d="M68.96 60L51.64 70V90L68.96 100L92.28 86.54" />
        <path d="M101.51 90.74L133.92 70L116.6 60L107.94 65" clipPath={`url(#${id}c3)`} />
        <path d="M116.6 60L99.28 70V90L116.6 100L139.92 86.54" />
      </g>
    </>
  );
}

/** The hexagon mark alone (square). */
export function BeeMark({ size = 24 }: { size?: number }) {
  return (
    <svg style={{ width: `${size / 16}rem`, height: `${size / 16}rem` }} viewBox="-2 -2 55 55" role="img" aria-label="bee">
      <MarkPaths />
    </svg>
  );
}

/** Mark + wordmark lockup; `height` sets the size, width follows the viewBox ratio. */
export function BeeLogo({ height = 22 }: { height?: number }) {
  return (
    <svg style={{ height: `${height / 16}rem`, width: `${(height * 213.33) / 58.6 / 16}rem` }} viewBox="0 47 213.33 58.6" role="img" aria-label="bee">
      <g transform="translate(0 47) scale(1.1453)">
        <MarkPaths />
      </g>
      <g transform="translate(74.41 0)">
        <WordPaths />
      </g>
    </svg>
  );
}
