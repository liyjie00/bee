import * as Y from 'yjs';
import {
  cellKey,
  parseCellKey,
  readSheet,
  sheetEntry,
  sheetsMap,
  type SheetCell,
  type SheetSnapshot,
} from '../../schema/sheet-data.js';

/**
 * Binds a Univer workbook to the spreadsheet data in a Bee Y.Doc (see sheet-data.ts).
 *
 * All tables of the document are loaded as sheets of one workbook, so cross-table formulas
 * (`=预算!D5`) are evaluated by Univer itself; only the active one is shown. Univer's own
 * collaboration server is not open source, so sync is state based instead of replaying commands:
 *
 * - local: after any Univer mutation, the touched sheet is compared with its Y entry and only the
 *   differing cells / meta fields are written (formula results included, so read-only views of the
 *   document show computed values without loading Univer);
 * - remote: changed cells are applied with SetRangeValuesMutation (fromCollab, so they stay out of
 *   the local undo stack); structural changes (rows, columns, merges, sizes) reload the workbook.
 */

type Presets = typeof import('@univerjs/presets');
type SheetsCore = typeof import('@univerjs/preset-sheets-core');

export const SHEET_ORIGIN = 'bee:sheet-local';

interface Modules {
  presets: Presets;
  core: SheetsCore;
  locales: Record<string, unknown>;
}

let modulesPromise: Promise<Modules> | null = null;

/** Univer and its styles, loaded on the first edit only (a few MB, kept out of the main bundle). */
export function loadUniver(locale: 'zh-CN' | 'en'): Promise<Modules> {
  return (modulesPromise ??= (async () => {
    const [presets, core, zh, en] = await Promise.all([
      import('@univerjs/presets'),
      import('@univerjs/preset-sheets-core'),
      import('@univerjs/preset-sheets-core/locales/zh-CN'),
      import('@univerjs/preset-sheets-core/locales/en-US'),
      import('@univerjs/preset-sheets-core/lib/index.css'),
    ]);
    void locale;
    return { presets, core, locales: { zhCN: zh.default, enUS: en.default } };
  })()).catch((err) => {
    modulesPromise = null;
    throw err;
  });
}

export interface SheetEditorOptions {
  container: HTMLElement;
  ydoc: Y.Doc;
  /** The document's sheets in document order; the first unique names win. */
  sheetIds: string[];
  activeSheetId: string;
  locale: 'zh-CN' | 'en';
  dark?: boolean;
  /** A remote change reloaded the workbook (the selection is lost). */
  onReload?: () => void;
}

export interface SheetEditor {
  /** Points the workbook at a new set of sheets (a table was added to or removed from the document). */
  setSheets(sheetIds: string[]): void;
  setDark(dark: boolean): void;
  /** Renames a sheet; Univer rewrites formulas that reference the old name. */
  rename(sheetId: string, name: string): void;
  dispose(): void;
}

const json = (v: unknown) => JSON.stringify(v ?? null);
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** Worksheet fields kept in the Y `meta` map; the rest are per-view (scroll, zoom) or not ours. */
const SKIP_META = new Set(['id', 'name', 'cellData', 'scrollTop', 'scrollLeft', 'zoomRatio', 'selections', 'tabColor']);

export async function mountSheetEditor(opts: SheetEditorOptions): Promise<SheetEditor> {
  const { presets, core, locales } = await loadUniver(opts.locale);
  const { createUniver, LocaleType, mergeLocales, ICommandService, IUniverInstanceService, CommandType, UniverInstanceType } = presets;
  const { UniverSheetsCorePreset } = core;
  const { ydoc } = opts;

  const { univer, univerAPI } = createUniver({
    locale: opts.locale === 'zh-CN' ? LocaleType.ZH_CN : LocaleType.EN_US,
    locales: {
      [LocaleType.ZH_CN]: mergeLocales(locales.zhCN as never),
      [LocaleType.EN_US]: mergeLocales(locales.enUS as never),
    },
    darkMode: !!opts.dark,
    presets: [
      UniverSheetsCorePreset({
        container: opts.container,
        header: true,
        toolbar: true,
        ribbonType: 'simple',
        footer: false,
        formulaBar: true,
        contextMenu: true,
      }),
    ],
  } as never);

  const injector = univer.__getInjector();
  const commands = injector.get(ICommandService);
  const instances = injector.get(IUniverInstanceService);

  const unitId = `bee-sheets-${Math.random().toString(36).slice(2, 10)}`;
  let sheetIds = opts.sheetIds.filter((id) => sheetEntry(ydoc, id));
  let applyingRemote = false;
  let disposed = false;

  type WorksheetModel = {
    getSnapshot(): Record<string, unknown> & { cellData?: Record<string, Record<string, SheetCell>> };
    getName(): string;
  };
  type WorkbookModel = {
    getSheetBySheetId(id: string): WorksheetModel | null | undefined;
    getStyles(): { get(id: unknown): SheetCell['s'] | null | undefined };
  };
  const workbook = () => instances.getUnit(unitId, UniverInstanceType.UNIVER_SHEET) as unknown as WorkbookModel | null;

  function workbookData() {
    const sheets: Record<string, unknown> = {};
    const used = new Set<string>();
    const order: string[] = [];
    for (const id of sheetIds) {
      const snap = readSheet(ydoc, id);
      if (!snap) continue;
      // Univer needs unique names; a concurrent rename can briefly produce duplicates.
      let name = snap.name || id;
      for (let i = 2; used.has(name.toLowerCase()); i++) name = `${snap.name}${i}`;
      used.add(name.toLowerCase());
      sheets[id] = toWorksheet(snap, name);
      order.push(id);
    }
    return { id: unitId, name: '', appVersion: '', locale: opts.locale === 'zh-CN' ? LocaleType.ZH_CN : LocaleType.EN_US, styles: {}, sheetOrder: order, sheets };
  }

  function load() {
    applyingRemote = true;
    try {
      univerAPI.createWorkbook(workbookData() as never);
      const fwb = univerAPI.getActiveWorkbook();
      const target = fwb?.getSheetBySheetId(opts.activeSheetId);
      if (target) fwb?.setActiveSheet(target);
    } finally {
      applyingRemote = false;
    }
  }

  function reload() {
    if (disposed) return;
    univerAPI.disposeUnit(unitId);
    load();
    opts.onReload?.();
  }

  // ---- local → Y ---------------------------------------------------------------------------
  const dirty = new Set<string>();
  const renamed = new Set<string>();
  let flushScheduled = false;
  const scheduleFlush = () => {
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      flush();
    });
  };

  function flush() {
    if (disposed) return;
    const wb = workbook();
    if (!wb) return;
    const ids = dirty.has('*') ? sheetIds : [...dirty].filter((id) => sheetIds.includes(id));
    dirty.clear();
    ydoc.transact(() => {
      for (const id of ids) {
        const ws = wb.getSheetBySheetId(id);
        const entry = sheetEntry(ydoc, id);
        if (!ws || !entry) continue;
        const snap = ws.getSnapshot();
        const styles = wb.getStyles();

        const cells = entry.get('cells') as Y.Map<SheetCell>;
        const seen = new Set<string>();
        for (const [r, row] of Object.entries(snap.cellData ?? {})) {
          for (const [c, raw] of Object.entries(row ?? {})) {
            const cell = normalizeCell(raw, styles);
            if (!cell) continue;
            const key = cellKey(Number(r), Number(c));
            seen.add(key);
            if (json(cells.get(key)) !== json(cell)) cells.set(key, cell);
          }
        }
        for (const key of [...cells.keys()]) if (!seen.has(key)) cells.delete(key);

        const meta = entry.get('meta') as Y.Map<unknown>;
        for (const [k, v] of Object.entries(snap)) {
          if (SKIP_META.has(k) || v === undefined) continue;
          if (json(meta.get(k)) !== json(v)) meta.set(k, clone(v));
        }
        // Names only on a local rename: a full compare could write back a name a peer just changed.
        const name = ws.getName();
        if (renamed.delete(id) && name && entry.get('name') !== name) entry.set('name', name);
      }
    }, SHEET_ORIGIN);
  }

  const commandListener = commands.onCommandExecuted((info) => {
    if (applyingRemote || disposed || info.type !== CommandType.MUTATION) return;
    const p = (info.params ?? {}) as { unitId?: unknown; subUnitId?: unknown };
    if (p.unitId && p.unitId !== unitId) return;
    dirty.add(typeof p.subUnitId === 'string' ? p.subUnitId : '*');
    if (info.id === 'sheet.mutation.set-worksheet-name' && typeof p.subUnitId === 'string') renamed.add(p.subUnitId);
    scheduleFlush();
  });

  // ---- Y → Univer --------------------------------------------------------------------------
  const sheets = sheetsMap(ydoc);
  const observer = (events: Y.YEvent<Y.AbstractType<unknown>>[], tr: Y.Transaction) => {
    if (tr.origin === SHEET_ORIGIN || disposed) return;
    let needReload = false;
    const cellChanges = new Map<string, Set<string>>();
    for (const ev of events) {
      const [sheetId, field] = ev.path as string[];
      if (sheetId === undefined) {
        // Entries added or replaced: only matters for sheets in this workbook.
        for (const key of ev.changes.keys.keys()) if (sheetIds.includes(key)) needReload = true;
        continue;
      }
      if (!sheetIds.includes(sheetId)) continue;
      if (field === 'cells') {
        const set = cellChanges.get(sheetId) ?? new Set<string>();
        for (const key of ev.changes.keys.keys()) set.add(key);
        cellChanges.set(sheetId, set);
      } else if (field === undefined && [...ev.changes.keys.keys()].every((k) => k === 'name')) {
        const name = String((sheetEntry(ydoc, sheetId)?.get('name') as string | undefined) ?? '');
        if (name) {
          applyingRemote = true;
          try {
            commands.syncExecuteCommand('sheet.mutation.set-worksheet-name', { unitId, subUnitId: sheetId, name }, { onlyLocal: true, fromCollab: true });
          } finally {
            applyingRemote = false;
          }
        }
      } else needReload = true;
    }
    if (needReload) return reload();
    applyingRemote = true;
    try {
      for (const [sheetId, keys] of cellChanges) {
        const cells = sheetEntry(ydoc, sheetId)?.get('cells') as Y.Map<SheetCell> | undefined;
        const clear: Record<number, Record<number, null>> = {};
        const set: Record<number, Record<number, SheetCell>> = {};
        for (const key of keys) {
          const rc = parseCellKey(key);
          if (!rc) continue;
          (clear[rc[0]] ??= {})[rc[1]] = null;
          const cell = cells?.get(key);
          if (cell) (set[rc[0]] ??= {})[rc[1]] = clone(cell);
        }
        const options = { onlyLocal: true, fromCollab: true };
        // Two steps, since the mutation merges into the old cell: clear, then write the new cell whole.
        commands.syncExecuteCommand('sheet.mutation.set-range-values', { unitId, subUnitId: sheetId, cellValue: clear }, options);
        if (Object.keys(set).length) commands.syncExecuteCommand('sheet.mutation.set-range-values', { unitId, subUnitId: sheetId, cellValue: set }, options);
      }
    } finally {
      applyingRemote = false;
    }
  };
  sheets.observeDeep(observer);

  load();
  // Formulas computed on load (and any normalisation Univer did) go back to Y.
  dirty.add('*');
  scheduleFlush();

  return {
    setSheets(ids) {
      const next = ids.filter((id) => sheetEntry(ydoc, id));
      if (json(next) === json(sheetIds)) return;
      sheetIds = next;
      reload();
    },
    setDark(dark) {
      univerAPI.toggleDarkMode(dark);
    },
    rename(sheetId, name) {
      univerAPI.getActiveWorkbook()?.getSheetBySheetId(sheetId)?.setName(name);
    },
    dispose() {
      if (disposed) return;
      flush();
      disposed = true;
      sheets.unobserveDeep(observer);
      commandListener.dispose();
      univer.dispose();
    },
  };
}

function toWorksheet(snap: SheetSnapshot, name: string) {
  const cellData: Record<number, Record<number, SheetCell>> = {};
  for (const [key, cell] of snap.cells) {
    const rc = parseCellKey(key);
    if (rc) (cellData[rc[0]] ??= {})[rc[1]] = clone(cell);
  }
  return { ...clone(snap.meta), id: snap.id, name, cellData };
}

/** A Univer cell as stored in Y: style ids resolved to inline styles, empty fields dropped. */
function normalizeCell(raw: SheetCell | null | undefined, styles: { get(id: unknown): SheetCell['s'] | null | undefined }): SheetCell | null {
  if (!raw) return null;
  const out: SheetCell = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null || v === '') continue;
    if (k === 's') {
      const style = (typeof v === 'string' ? styles.get(v) : v) as SheetCell['s'];
      if (style && Object.keys(style).length) out.s = clone(style);
    } else out[k] = clone(v);
  }
  return Object.keys(out).length ? out : null;
}

