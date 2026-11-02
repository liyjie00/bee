import type { AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { common, createLowlight } from 'lowlight';
import { BlockId } from './block-id.js';
import { Whiteboard } from './whiteboard.js';
import { TaskListShortcuts } from './task-shortcuts.js';

export { BlockId, BLOCK_TYPES, BLOCK_ID_ATTR, newBlockId } from './block-id.js';
export { Whiteboard } from './whiteboard.js';

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
      link: { openOnClick: false, autolink: true, defaultProtocol: 'https' },
      // Placeholder/dropcursor etc. are added by the React layer.
      trailingNode: false,
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    TaskListShortcuts,
    TableKit.configure({ table: { resizable: true } }),
    Image.configure({ inline: false, allowBase64: false }),
    CodeBlockLowlight.configure({ lowlight, defaultLanguage: null }),
    Whiteboard,
    BlockId,
  ];
}
