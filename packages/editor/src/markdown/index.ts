import * as Y from 'yjs';
import { getSchema } from '@tiptap/core';
import { prosemirrorJSONToYDoc, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { generateUniqueIds } from '@tiptap/extension-unique-id';
import { schemaExtensions } from '../schema/index.js';
import { BLOCK_ID_ATTR } from '../schema/block-id.js';
import { jsonToMarkdown } from './to-markdown.js';
import { markdownToJSON } from './from-markdown.js';
import type { JSONNode } from './types.js';

export type { JSONNode, JSONMark } from './types.js';
export { jsonToMarkdown } from './to-markdown.js';
export { markdownToJSON } from './from-markdown.js';

/** Name of the Y.XmlFragment holding rich text (Tiptap Collaboration default). */
export const RICH_TEXT_FIELD = 'default';

let schema: ReturnType<typeof getSchema> | undefined;
const extensions = () => schemaExtensions({ collaborative: true });
const beeSchema = () => (schema ??= getSchema(extensions()));

function docFromUpdate(update: Uint8Array): Y.Doc {
  const doc = new Y.Doc();
  if (update.byteLength) Y.applyUpdate(doc, update);
  return doc;
}

export function yDocToJSON(ydoc: Y.Doc, field = RICH_TEXT_FIELD): JSONNode {
  return yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment(field)) as JSONNode;
}

export function yUpdateToJSON(update: Uint8Array, field = RICH_TEXT_FIELD): JSONNode {
  return yDocToJSON(docFromUpdate(update), field);
}

export function yDocToMarkdown(ydoc: Y.Doc, field = RICH_TEXT_FIELD): string {
  return jsonToMarkdown(yDocToJSON(ydoc, field));
}

export function yUpdateToMarkdown(update: Uint8Array, field = RICH_TEXT_FIELD): string {
  return yDocToMarkdown(docFromUpdate(update), field);
}

/** Builds a Yjs document from Tiptap JSON (block ids are assigned where missing). */
export function jsonToYUpdate(json: JSONNode, field = RICH_TEXT_FIELD): Uint8Array {
  const withIds = generateUniqueIds(json, extensions()) as JSONNode;
  const doc = prosemirrorJSONToYDoc(beeSchema(), withIds, field);
  return Y.encodeStateAsUpdate(doc);
}

/** Imports Markdown as the initial Yjs state of a new document. */
export function markdownToYUpdate(markdown: string, field = RICH_TEXT_FIELD): Uint8Array {
  return jsonToYUpdate(markdownToJSON(markdown), field);
}

function collectBlockIds(node: JSONNode, out: Set<string>) {
  const id = node.attrs?.[BLOCK_ID_ATTR];
  if (typeof id === 'string') out.add(id);
  for (const child of node.content ?? []) collectBlockIds(child, out);
}

export function yUpdateBlockIds(update: Uint8Array, field = RICH_TEXT_FIELD): Set<string> {
  const ids = new Set<string>();
  collectBlockIds(yUpdateToJSON(update, field), ids);
  return ids;
}

export function yUpdateHasBlock(update: Uint8Array, blockId: string, field = RICH_TEXT_FIELD): boolean {
  return yUpdateBlockIds(update, field).has(blockId);
}

/** Plain text of a document, e.g. for search indexing. */
export function jsonToText(node: JSONNode): string {
  if (node.text) return node.text;
  const sep = node.type === 'doc' || node.type.endsWith('List') || node.type === 'table' ? '\n' : node.type === 'tableRow' ? '\t' : '';
  return (node.content ?? []).map(jsonToText).join(sep);
}
export { appendBlocks, applyMarkdown, type ApplyResult } from './apply.js';
