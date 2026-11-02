import type { AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { common, createLowlight } from 'lowlight';
import { BlockId } from './block-id.js';
import { Whiteboard } from './whiteboard.js';
import { Column, Columns } from './columns.js';
import { TaskListShortcuts } from './task-shortcuts.js';
import { StyledTableCell, StyledTableHeader } from './table-style.js';

export { BlockId, BLOCK_TYPES, BLOCK_ID_ATTR, newBlockId } from './block-id.js';
export { Whiteboard, parseWhiteboardView, formatWhiteboardView, type WhiteboardView, type WhiteboardAlign } from './whiteboard.js';
export { Column, Columns } from './columns.js';
export { CELL_COLORS, CELL_ALIGNS, type CellColor, type CellAlign } from './table-style.js';

export const lowlight = createLowlight(common);

export interface SchemaOptions {
  /** True when Yjs owns history; disables the local undo/redo extension. */
  collaborative?: boolean;
}

/**
 * Extensions that define the Bee document schema, without React node views. Safe to import in Node
 * (used by `@bee/editor/markdown` to build Yjs docs on the server).
 */
export function schemaExtensions({ collaborative = true }: SchemaOptions = {}): AnyExtension[] {
  return [
    StarterKit.configure({
      codeBlock: false,
      undoRedo: collaborative ? false : undefined,
      // Clicking a link opens it in a new tab (target=_blank is the Link default).
      link: { openOnClick: true, autolink: true, defaultProtocol: 'https' },
      // Placeholder/dropcursor etc. are added by the React layer.
      trailingNode: false,
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TaskListShortcuts,
    TableKit.configure({ table: { resizable: true }, tableCell: false, tableHeader: false }),
    StyledTableCell,
    StyledTableHeader,
    Image.configure({ inline: false, allowBase64: false }),
    CodeBlockLowlight.configure({ lowlight, defaultLanguage: null }),
    Whiteboard,
    Columns,
    Column,
    BlockId,
  ];
}
