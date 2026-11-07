import { createContext, useContext } from 'react';
import type { BeeUser } from './collab.js';
import type { Locale } from './i18n.js';
import type { Theme } from './theme.js';
import type { LightboxContent } from './Lightbox.js';

/** Host-provided services available to node views (rendered inside the editor's React tree). */
export interface BeeEditorContextValue {
  documentId: string;
  collabUrl: string;
  shareToken?: string;
  user: BeeUser;
  editable: boolean;
  locale: Locale;
  theme?: Theme;
  onOpenWhiteboard?: (documentId: string) => void;
  whiteboardTitle?: (documentId: string) => string | undefined;
  /** Opens the full-window image viewer. */
  openLightbox?: (content: LightboxContent) => void;
}

export const BeeEditorContext = createContext<BeeEditorContextValue | null>(null);
export const useBeeEditorContext = () => useContext(BeeEditorContext);
