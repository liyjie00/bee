# @bee/editor

Tiptap + Yjs editor used by `apps/web`, plus a DOM-free Markdown serializer used by `apps/collab`.

## Collaboration wire

- WebSocket URL: `${location.origin.replace(/^http/, 'ws')}/collab` (Caddy → collab:1234).
- Document name: the document UUID. Whiteboards are their own documents (type `whiteboard`).
- Auth: the `bee_session` cookie rides on the WS upgrade. Public share links pass the share token as `shareToken`.
- Roles: `owner`/`editor` connect read-write; `commenter`/`viewer` are read-only on the Yjs doc.
- Yjs layout: rich text in XmlFragment `default`; whiteboards in Y.Map `elements` (+ Y.Map `files`).

## Usage

```tsx
import { BeeEditor, BeeWhiteboard, scrollToBlock, blockLink } from '@bee/editor';
import '@bee/editor/styles.css';

<BeeEditor
  documentId={doc.id}
  collabUrl={wsUrl}
  shareToken={token}              // optional, public links
  user={{ id: me.id, name: me.name, color: '#3b7dd8' }}
  editable={role === 'owner' || role === 'editor'}
  canComment={role !== 'viewer'}
  comments={threads.map(t => ({ id: t.id, anchor: t.anchor, resolved: t.resolved }))}
  activeCommentId={activeId}
  onCommentClick={id => setActiveId(id)}
  onCreateComment={anchor => openDraft(anchor)}   // from the selection bubble "Comment" button
  uploadImage={file => api.upload(file)}          // resolves to an image URL
  createWhiteboard={() => api.createDoc({ type: 'whiteboard', parentDocumentId: doc.id })} // -> { documentId }
  onOpenWhiteboard={id => navigate(`/d/${id}`)}
  onReady={editor => (editorRef.current = editor)}
  onStatus={s => setSaved(s)}                     // 'connecting' | 'connected' | 'synced' | 'disconnected'
  onPresence={users => setPresence(users)}
/>
```

Anchor links: every block has a stable `blockId`. Link format `/d/<docId>#b-<blockId>` (`blockLink(origin, docId, blockId)`).
After the editor reports `synced`, call `scrollToBlock(editor, blockId)`; it returns `false` when the block no longer
exists. Hovering a block shows a link button that calls `onCopyBlockLink(blockId)` (or copies `blockLink` by default).

Comments: `CommentAnchor = { blockId, from, to, quote }` where `from`/`to` are Y.RelativePosition JSON. Store it as
opaque JSON. Highlights are decorations only (nothing is written into the doc), so commenters stay read-only.

Other exports:
- `BeeWhiteboard` — `{ documentId, collabUrl, shareToken?, user, editable, onStatus? }`, full-page Excalidraw board.
- `BeeVersionPreview` — `{ update: Uint8Array }`, read-only render of a version snapshot.
- `restoreVersion(editor, update)` — replaces the live content with a snapshot (as a normal, undoable edit).
- `editorToMarkdown(editor)`, `insertMarkdown(editor, md)`.
- `@bee/editor/markdown` (no DOM/React): `yDocToMarkdown(ydoc)`, `yUpdateToMarkdown(update)`, `jsonToMarkdown(json)`.
