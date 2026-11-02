import { createContext, useContext } from 'react';
import type { BeeUser } from './collab.js';
import type { Locale } from './i18n.js';

/** Host-provided services available to node views (rendered inside the editor's React tree). */
export interface BeeEditorContextValue {
  documentId: string;
  collabUrl: string;
  shareToken?: string;
  user: BeeUser;
  editable: boolean;
  locale: Locale;
  onOpenWhiteboard?: (documentId: string) => void;
}

export const BeeEditorContext = createContext<BeeEditorContextValue | null>(null);
export const useBeeEditorContext = () => useContext(BeeEditorContext);
