import { useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import * as Y from 'yjs';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { useCollabConnection, type BeeUser, type CollabStatus, type LoadSnapshot } from './collab.js';
import { useTheme, type Theme } from './theme.js';
import { MessagesContext, resolveMessages, useMessages, type Locale, type Messages } from './i18n.js';
import { WhiteboardConnectors } from './WhiteboardConnectors.js';
import type { WhiteboardView } from '../schema/whiteboard.js';

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

/** Lets an embed read what the board currently shows. */
export interface WhiteboardHandle {
  getView(): WhiteboardView | null;
  /** Zooms to the whole drawing now, without touching the saved range. */
  fitAll(): void;
  /** The drawing as an image; null when there is nothing to export. */
  exportImage(type: 'png' | 'jpeg', opts?: { background?: boolean; onlySelected?: boolean }): Promise<Blob | null>;
  /** The drawing as an .excalidraw file (JSON), for offline copies or excalidraw.com. */
  exportScene(): string;
  /** Adds the drawing in an .excalidraw file to this board (undoable). */
  importScene(file: Blob): Promise<void>;
}

/** Shows `view` (scene units) centred in the canvas, as large as fits. */
function showView(api: ExcalidrawAPI, view: WhiteboardView) {
  const { width, height } = api.getAppState();
  if (!width || !height) return;
  const zoom = Math.min(30, Math.max(0.1, Math.min(width / view.w, height / view.h)));
  api.updateScene({
    appState: {
      zoom: { value: zoom as never },
      scrollX: -view.x + (width / zoom - view.w) / 2,
      scrollY: -view.y + (height / zoom - view.h) / 2,
    },
  });
}

/** Zooms to the whole drawing with a small margin, never past 100%. */
function fitAll(api: ExcalidrawAPI) {
  const { width, height } = api.getAppState();
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const el of api.getSceneElements()) {
    // Arrows and lines extend from their first point by `points`, possibly in negative directions.
    const pts: readonly (readonly [number, number])[] =
      'points' in el && el.points.length ? el.points : [[0, 0], [el.width, el.height]];
    for (const [px, py] of pts) {
      x1 = Math.min(x1, el.x + px);
      y1 = Math.min(y1, el.y + py);
      x2 = Math.max(x2, el.x + px);
      y2 = Math.max(y2, el.y + py);
    }
  }
  if (!width || !height || x1 > x2) return;
  const pad = 24; // screen px on each side
  const w = Math.max(x2 - x1, 1);
  const h = Math.max(y2 - y1, 1);
  const zoom = Math.min(1, Math.max(0.1, Math.min((width - 2 * pad) / w, (height - 2 * pad) / h)));
  api.updateScene({
    appState: {
      zoom: { value: zoom as never },
      scrollX: -x1 + (width / zoom - w) / 2,
      scrollY: -y1 + (height / zoom - h) / 2,
    },
  });
}

/** New shapes default to a clean, draw.io-like look instead of Excalidraw's hand-drawn one. */
const CLEAN_STYLE = {
  currentItemRoughness: 0,
  currentItemFontFamily: 6, // Nunito
  currentItemArrowType: 'sharp',
};

interface BoardProps {
  ydoc: Y.Doc;
  provider: HocuspocusProvider;
  user: BeeUser;
  editable: boolean;
  /** Compact embed: hides most chrome. */
  embedded?: boolean;
  /** Zoom to fit the drawing once loaded. */
  fitContent?: boolean;
  /** Part of the scene to show; overrides fitContent. */
  view?: WhiteboardView | null;
  onHandle?: (handle: WhiteboardHandle | null) => void;
  locale: Locale;
  theme?: Theme;
}

/**
 * Excalidraw bound to a Yjs document: every element is stored in Y.Map `elements` keyed by id, and
 * merged by Excalidraw's own version-based reconciliation. Images go to Y.Map `files`.
 */
function Board({ ydoc, provider, user, editable, embedded, fitContent, view, onHandle, locale, theme: themeProp }: BoardProps) {
  const [mod, setMod] = useState<ExcalidrawModule | null>(null);
  const apiRef = useRef<ExcalidrawAPI | null>(null);
  const [api, setApi] = useState<ExcalidrawAPI | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const placement = useRef({ view, fitContent });
  placement.current = { view, fitContent };
  /** Applies the saved range (or the fit) on load, when it changes and when the embed is resized. */
  const place = useCallback(() => {
    const a = apiRef.current;
    const { view: v, fitContent: fit } = placement.current;
    if (!a) return;
    if (v) showView(a, v);
    else if (fit) fitAll(a);
  }, []);
  const viewKey = view ? `${view.x},${view.y},${view.w},${view.h}` : '';
  useEffect(() => {
    if (viewKey || fitContent) requestAnimationFrame(place);
  }, [viewKey, fitContent, place]);
  useEffect(() => {
    const el = host.current;
    if (!el || !embedded) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        // Make Excalidraw pick up the new canvas size first.
        apiRef.current?.refresh();
        requestAnimationFrame(place);
      }, 150);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      clearTimeout(timer);
    };
  }, [embedded, place, mod]);
  useEffect(() => {
    onHandle?.({
      getView: () => {
        const a = apiRef.current;
        if (!a) return null;
        const s = a.getAppState();
        const z = s.zoom.value;
        return { x: -s.scrollX, y: -s.scrollY, w: s.width / z, h: s.height / z };
      },
      fitAll: () => {
        if (apiRef.current) fitAll(apiRef.current);
      },
      exportImage: async (type, opts = {}) => {
        const a = apiRef.current;
        const m = mod ?? (await loadExcalidraw());
        if (!a) return null;
        const appState = a.getAppState();
        let elements = a.getSceneElements();
        if (opts.onlySelected) {
          const ids = appState.selectedElementIds;
          const picked = elements.filter((el: SceneElement) => ids[el.id]);
          if (picked.length) elements = picked;
        }
        if (!elements.length) return null;
        return m.exportToBlob({
          elements,
          files: a.getFiles(),
          mimeType: type === 'png' ? 'image/png' : 'image/jpeg',
          // JPEG has no transparency: it always gets the background.
          appState: { ...appState, exportBackground: type === 'jpeg' || opts.background !== false, exportScale: 2 },
          exportPadding: 24,
        });
      },
      exportScene: () => {
        const a = apiRef.current;
        if (!a || !mod) return '';
        return mod.serializeAsJSON(a.getSceneElements(), a.getAppState(), a.getFiles(), 'local');
      },
      importScene: async (file) => {
        const a = apiRef.current;
        const m = mod ?? (await loadExcalidraw());
        if (!a) return;
        const scene = await m.loadFromBlob(file, null, null);
        const incoming = scene.elements.filter((el: SceneElement) => !el.isDeleted);
        const ids = new Set(incoming.map((el: SceneElement) => el.id));
        a.addFiles(Object.values(scene.files ?? {}));
        a.updateScene({
          elements: [...a.getSceneElementsIncludingDeleted().filter((el: SceneElement) => !ids.has(el.id)), ...incoming],
          captureUpdate: m.CaptureUpdateAction.IMMEDIATELY,
        });
        requestAnimationFrame(() => apiRef.current && fitAll(apiRef.current));
      },
    });
    return () => onHandle?.(null);
  }, [onHandle, mod]);
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
    <div ref={host} className="bee-whiteboard-canvas">
    <Excalidraw
      excalidrawAPI={(api: ExcalidrawAPI) => {
        apiRef.current = api;
        setApi(api);
        applyRemote();
        requestAnimationFrame(place);
      }}
      initialData={{
        elements: [...elementsMap.values()].map((el) => structuredClone(el)),
        files: Object.fromEntries(filesMap.entries()),
        appState: CLEAN_STYLE,
      }}
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
    {editable && api && <WhiteboardConnectors api={api} mod={mod} />}
    </div>
  );
}

export interface BeeWhiteboardProps {
  documentId: string;
  collabUrl: string;
  shareToken?: string;
  /** Stored Yjs state fetched over HTTP, rendered before the collab sync completes. */
  loadSnapshot?: LoadSnapshot;
  user: BeeUser;
  editable: boolean;
  embedded?: boolean;
  /** Zoom to fit the drawing once loaded (embeds of existing boards). */
  fitContent?: boolean;
  /** Part of the scene to show (an embed's saved display range). */
  view?: WhiteboardView | null;
  onHandle?: (handle: WhiteboardHandle | null) => void;
  locale?: Locale;
  /** Defaults to `<html data-theme>`, then the OS preference. */
  theme?: Theme;
  messages?: Partial<Messages>;
  onStatus?: (status: CollabStatus) => void;
}

/** A whiteboard document (its own Y.Doc), full page or embedded in a rich-text document. */
export function BeeWhiteboard({ documentId, collabUrl, shareToken, loadSnapshot, user, editable, embedded, fitContent, view, onHandle, locale, theme, messages, onStatus }: BeeWhiteboardProps) {
  const [synced, setSynced] = useState(false);
  const conn = useCollabConnection(
    documentId,
    collabUrl,
    shareToken,
    (s) => {
      if (s === 'synced') setSynced(true);
      onStatus?.(s);
    },
    loadSnapshot,
    () => setSynced(true),
  );
  const t = resolveMessages(locale, messages);
  return (
    <MessagesContext.Provider value={t}>
      <div className={`bee-whiteboard${embedded ? ' bee-whiteboard-embedded' : ''}`}>
        {conn && synced ? (
          <Board ydoc={conn.ydoc} provider={conn.provider} user={user} editable={editable} embedded={embedded} fitContent={fitContent} view={view} onHandle={onHandle} locale={locale ?? 'en'} theme={theme} />
        ) : (
          <div className="bee-whiteboard-loading">{t.whiteboardLoading}</div>
        )}
      </div>
    </MessagesContext.Provider>
  );
}
