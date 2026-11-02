import { UniqueID } from '@tiptap/extension-unique-id';
import { isChangeOrigin } from '@tiptap/extension-collaboration';
import { nanoid } from 'nanoid';

/** Node types that get a stable `blockId`, the target of `/d/<docId>#b-<blockId>` anchor links. */
export const BLOCK_TYPES = [
  'paragraph',
  'heading',
  'blockquote',
  'listItem',
  'taskItem',
  'codeBlock',
  'image',
  'table',
  'whiteboard',
  'sheet',
  'horizontalRule',
];

export const BLOCK_ID_ATTR = 'blockId';

export const newBlockId = () => nanoid(10);

/**
 * Assigns ids to new blocks. On split/paste the first node keeps the id and later duplicates get new
 * ones. Remote (collaboration) transactions are skipped so only the author's client assigns ids.
 */
export const BlockId = UniqueID.configure({
  attributeName: BLOCK_ID_ATTR,
  types: BLOCK_TYPES,
  generateID: newBlockId,
  filterTransaction: (tr) => !isChangeOrigin(tr),
});
