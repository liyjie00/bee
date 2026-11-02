import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import * as Y from 'yjs';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { useCollabConnection, type BeeUser, type CollabStatus } from './collab.js';
import { useTheme, type Theme } from './theme.js';
import { MessagesContext, resolveMessages, useMessages, type Locale, type Messages } from './i18n.js';

type ExcalidrawModule = typeof import('@excalidraw/excalidraw');
type ExcalidrawAPI = Parameters<NonNullable<import('@excalidraw/excalidraw/types').ExcalidrawProps['excalidrawAPI']>>[0];
type SceneElement = Parameters<ExcalidrawModule['reconcileElements']>[0][number];
type BinaryFiles = import('@excalidraw/excalidraw/types').BinaryFiles;

let excalidrawPromise: Promise<ExcalidrawModule> | null = null;
const loadExcalidraw = () => (excalidrawPromise ??= import('@excalidraw/excalidraw'));

/** Y.Map names used by whiteboard documents. */
export const WHITEBOARD_ELEMENTS = 'elements';
export const WHITEBOARD_FILES = 'files';

const LOCAL_ORIGIN = 'bee:whiteboard-local';

interface BoardProps {
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  user: BeeUser;
  editable: boolean;
  /** Compact embed: hides most chrome. */
  embedded?: boolean;
  /** Zoom to fit the drawing once loaded. */
  fitContent?: boolean;
  locale: Locale;
  theme?: Theme;
}

/**
 * Excalidraw bound to a Yjs document: every element is stored in Y.Map `elements` keyed by id, and
 * merged by Excalidraw's own version-based reconciliation. Images go to Y.Map `files`.
 */
function Board({ ydoc, provider, user, editable, embedded, fitContent, locale, theme: themeProp }: BoardProps) {
  const [mod, setMod] = useState<ExcalidrawModule | null>(null);
  const apiRef = useRef<ExcalidrawAPI | null>(null);
  const t = useMessages();
  const theme = useTheme(themeProp);

  useEffect(() => {
    let alive = true;
    void loadExcalidraw().then((m) => alive && setMod(m));
    return () => {
      alive = false;
    };
  }, []);

  const elementsMap = ydoc.getMap<SceneElement>(WHITEBOARD_ELEMENTS);
  const filesMap = ydoc.getMap<BinaryFiles[string]>(WHITEBOARD_FILES);

  const applyRemote = useCallback(() => {
    const api = apiRef.current;
    if (!api || !mod) return;
    const remote = [...elementsMap.values()].map((el) => structuredClone(el));
    const merged = mod.reconcileElements(api.getSceneElementsIncludingDeleted(), remote as never, api.getAppState());
    api.updateScene({ elements: merged, captureUpdate: mod.CaptureUpdateAction.NEVER });
    const known = api.getFiles();
    const missing = [...filesMap.values()].filter((f) => !known[f.id]);
    if (missing.length) api.addFiles(missing);
  }, [elementsMap, filesMap, mod]);

  useEffect(() => {
    const onChange = (_: unknown, tr: Y.Transaction) => {
      if (tr.origin !== LOCAL_ORIGIN) applyRemote();
    };
    elementsMap.observe(onChange);
    filesMap.observe(onChange);
    return () => {
      elementsMap.unobserve(onChange);
      filesMap.unobserve(onChange);
    };
  }, [elementsMap, filesMap, applyRemote]);

  // Remote pointers -> Excalidraw collaborators.
  useEffect(() => {
    const awareness = provider.awareness;
    if (!awareness) return;
    awareness.setLocalStateField('user', user);
    const update = () => {
      const api = apiRef.current;
      if (!api) return;
      const collaborators = new Map();
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID || !state.user) return;
        const u = state.user as BeeUser;
        collaborators.set(String(clientId), {
          username: u.name,
          pointer: state.pointer,
          color: { background: u.color, stroke: u.color },
        });
      });
      api.updateScene({ collaborators });
    };
    awareness.on('change', update);
    return () => awareness.off('change', update);
  }, [provider, user]);

  const onChange = useCallback(
    (elements: readonly SceneElement[], _appState: unknown, files: BinaryFiles) => {
      if (!editable) return;
      ydoc.transact(() => {
        for (const el of elements) {
          const prev = elementsMap.get(el.id);
          // Excalidraw mutates elements in place, so store a snapshot rather than the live object.
          if (!prev || prev.version < el.version) elementsMap.set(el.id, structuredClone(el));
        }
        for (const file of Object.values(files)) if (!filesMap.has(file.id)) filesMap.set(file.id, file);
      }, LOCAL_ORIGIN);
    },
    [editable, ydoc, elementsMap, filesMap],
  );

  if (!mod) return <div className="bee-whiteboard-loading">{t.whiteboardLoading}</div>;
  const Excalidraw = mod.Excalidraw as unknown as ComponentType<Record<string, unknown>>;

  return (
    <Excalidraw
      excalidrawAPI={(api: ExcalidrawAPI) => {
        apiRef.current = api;
        applyRemote();
        if (fitContent)
          requestAnimationFrame(() =>
            api.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.9, animate: false }),
          );
      }}
      initialData={{ elements: [...elementsMap.values()].map((el) => structuredClone(el)), files: Object.fromEntries(filesMap.entries()) }}
      onChange={onChange}
      onPointerUpdate={({ pointer }: { pointer: { x: number; y: number } }) =>
        provider.awareness?.setLocalStateField('pointer', pointer)
      }
      isCollaborating
      viewModeEnabled={!editable}
      zenModeEnabled={embedded}
      theme={theme}
      langCode={locale === 'zh-CN' ? 'zh-CN' : 'en'}
      UIOptions={embedded ? { canvasActions: { loadScene: false, saveToActiveFile: false, export: false } } : undefined}
    />
  );
}

export interface BeeWhiteboardProps {
  documentId: string;
  collabUrl: string;
  shareToken?: string;
  user: BeeUser;
  editable: boolean;
  embedded?: boolean;
  /** Zoom to fit the drawing once loaded (embeds of existing boards). */
  fitContent?: boolean;
  locale?: Locale;
  /** Defaults to `<html data-theme>`, then the OS preference. */
  theme?: Theme;
  messages?: Partial<Messages>;
  onStatus?: (status: CollabStatus) => void;
}

/** A whiteboard document (its own Y.Doc), full page or embedded in a rich-text document. */
export function BeeWhiteboard({ documentId, collabUrl, shareToken, user, editable, embedded, fitContent, locale, theme, messages, onStatus }: BeeWhiteboardProps) {
  const [synced, setSynced] = useState(false);
  const conn = useCollabConnection(documentId, collabUrl, shareToken, (s) => {
    if (s === 'synced') setSynced(true);
    onStatus?.(s);
  });
  const t = resolveMessages(locale, messages);
  return (
    <MessagesContext.Provider value={t}>
      <div className={`bee-whiteboard${embedded ? ' bee-whiteboard-embedded' : ''}`}>
        {conn && synced ? (
          <Board ydoc={conn.ydoc} provider={conn.provider} user={user} editable={editable} embedded={embedded} fitContent={fitContent} locale={locale ?? 'en'} theme={theme} />
        ) : (
          <div className="bee-whiteboard-loading">{t.whiteboardLoading}</div>
        )}
      </div>
    </MessagesContext.Provider>
  );
}
