import type { CSSProperties } from 'react';
import { ICON_SPRITE } from './sprite';

export type IconName =
  | 'doc' | 'folder' | 'board' | 'sheet' | 'search' | 'home' | 'bell' | 'star' | 'trash' | 'plus' | 'chev'
  | 'down' | 'lock' | 'globe' | 'link' | 'clock' | 'chat' | 'more' | 'x' | 'check' | 'grip' | 'code' | 'image'
  | 'flow' | 'list' | 'grid' | 'cursor' | 'hand' | 'rect' | 'diamond' | 'circle' | 'arrow' | 'pen' | 'text'
  | 'note' | 'menu' | 'copy' | 'restore' | 'gear' | 'spark' | 'sun' | 'moon' | 'upload' | 'bug' | 'user' | 'plug';

export function Icon({ name, size, className, style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  const s = size ? { width: `${size / 16}rem`, height: `${size / 16}rem`, ...style } : style;
  return (
    <svg className={'i' + (className ? ' ' + className : '')} style={s} aria-hidden="true">
      <use href={`#i-${name}`} />
    </svg>
  );
}

export function IconSprite() {
  return (
    <svg
      width="0"
      height="0"
      style={{ position: 'absolute' }}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: ICON_SPRITE }}
    />
  );
}

export const docIcon = (type: string): IconName => (type === 'whiteboard' ? 'board' : type === 'sheet' ? 'sheet' : 'doc');
