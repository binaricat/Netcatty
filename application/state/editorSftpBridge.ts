import type { SftpFilenameEncoding } from "../../types";

export interface EditorSftpWrite {
  (
    connectionId: string,
    expectedHostId: string,
    filePath: string,
    content: string,
    filenameEncoding?: SftpFilenameEncoding,
  ): Promise<void>;
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

export const registerEditorSftpWriter = (fn: EditorSftpWrite | null) => {
  // Pass `null` on cleanup — but cleanup also needs to know WHICH writer to
  // remove. Callers who register once per mount should instead use
  // `registerEditorSftpWriterScoped` below, which returns an unregister fn.
  // This legacy signature is preserved for callers that prefer the
  // register/unregister-with-null pattern: we clear ALL writers on null.
  if (fn === null) {
    writers.clear();
    return;
  }
  writers.add(fn);
};

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
      await fn(...args);
      return;
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
