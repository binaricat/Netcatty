import type { SftpFilenameEncoding } from "../../types";

export interface EditorSftpWrite {
  (
    connectionId: string,
    expectedHostId: string,
    filePath: string,
    content: string,
    filenameEncoding?: SftpFilenameEncoding,
    sftpTabId?: string,
  ): Promise<string>;
}

// `useSftpState` is instantiated in at least two places (the top-level SftpView
// and the per-terminal SftpSidePanel), each owning its own pane registry. An
// editor tab opened from either path must be saved via the matching instance,
// so the bridge tracks all currently-mounted writers and dispatches by
// attempting each in turn until one succeeds.
//
// Each writer throws synchronously (or rejects) if the connectionId isn't in
// its pane registry; we use "connection no longer available" text as the
// signal to fall through to the next writer. Any other error is re-thrown
// immediately because it represents a real save failure the user must see.
const writers = new Set<EditorSftpWrite>();

const NOT_MY_CONNECTION_RE = /SFTP connection is no longer available/i;

export const registerEditorSftpWriterScoped = (fn: EditorSftpWrite): (() => void) => {
  writers.add(fn);
  return () => {
    writers.delete(fn);
  };
};

export const editorSftpWrite: EditorSftpWrite = async (...args) => {
  if (writers.size === 0) {
    throw new Error("SFTP editor bridge not registered — cannot save (no SFTP view mounted)");
  }
  let lastNotMine: Error | null = null;
  for (const fn of writers) {
    try {
      return await fn(...args);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (NOT_MY_CONNECTION_RE.test(msg)) {
        // This writer doesn't own the connectionId — try the next one.
        lastNotMine = err instanceof Error ? err : new Error(msg);
        continue;
      }
      // Real save error — surface it.
      throw err;
    }
  }
  // No writer owned the connectionId.
  throw lastNotMine ?? new Error("SFTP connection is no longer available");
};
