import type * as Monaco from "monaco-editor";

export type FileModels = {
  original: Monaco.editor.ITextModel;
  modified: Monaco.editor.ITextModel;
  // What the file on disk holds as far as we know; a save must find exactly this there.
  saved: string;
  saving: Promise<void>;
  timer: ReturnType<typeof setTimeout> | undefined;
  listener: Monaco.IDisposable;
  deleting?: boolean;
  reloading?: boolean;
};
export type SaveFile = (path: string, content: string, expected: string) => Promise<unknown>;
type SaveCallbacks = { current: { save: SaveFile; onError(message: string | null): void; onConflict?(path: string, conflicted: boolean): void } };

// Saves run one at a time per file, so each one expects what the previous one wrote.
export function flushFile(path: string, m: FileModels, callbacks: SaveCallbacks) {
  clearTimeout(m.timer);
  m.timer = undefined;
  const content = m.modified.getValue();
  m.saving = m.saving.then(async () => {
    if (m.reloading || content === m.saved) return;
    try {
      await callbacks.current.save(path, content, m.saved);
      m.saved = content;
      callbacks.current.onConflict?.(path, false);
      callbacks.current.onError(null);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.includes("changed on disk since it was loaded")) callbacks.current.onConflict?.(path, true);
      callbacks.current.onError(message);
    }
  });
}

export function reconcileFile(m: FileModels, oldText: string, newText: string) {
  if (m.reloading) return;
  if (m.original.getValue() !== oldText) m.original.setValue(oldText);
  const value = m.modified.getValue();
  if (newText === value) m.saved = value;
  // A file with unsaved edits keeps them; its next save then reports the change on disk.
  else if (value === m.saved) {
    m.saved = newText;
    m.modified.setValue(newText);
  }
}

export async function reloadFile(m: FileModels, read: () => Promise<string>) {
  m.reloading = true;
  clearTimeout(m.timer);
  m.timer = undefined;
  try {
    await m.saving;
    const content = await read();
    if (m.modified.isDisposed()) return;
    m.saved = content;
    m.modified.setValue(content);
  } finally {
    m.reloading = false;
  }
}

export function releaseFile(path: string, m: FileModels, callbacks: SaveCallbacks) {
  m.listener.dispose();
  if (m.timer !== undefined) flushFile(path, m, callbacks);
  m.original.dispose();
  m.modified.dispose();
}
