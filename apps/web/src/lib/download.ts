/** Saves a blob as a file download. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A file name from a document title, without characters file systems reject. */
export const fileName = (title: string, ext: string, fallback = 'Untitled') =>
  `${(title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').trim() || fallback).slice(0, 100)}.${ext}`;

/** Opens a file picker and resolves to the chosen file (null when cancelled). */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/** A file to import into a whiteboard once it has opened (from "New › Import .excalidraw"). */
export const pendingBoardImports = new Map<string, File>();
