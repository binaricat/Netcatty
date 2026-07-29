/**
 * Shared Monaco paste helpers for Electron, where Monaco's built-in
 * clipboardPasteAction often cannot read the OS clipboard.
 */

export const MONACO_CLIPBOARD_PASTE_COMMAND_ID = 'editor.action.clipboardPasteAction';

export type MonacoPasteRange = {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
};

export type MonacoPasteEdit = {
  range: MonacoPasteRange;
  text: string;
  forceMoveMarkers: true;
};

/**
 * Build executeEdits payloads matching Monaco multicursorPaste:'spread':
 * when cursor count equals clipboard line count, distribute one line per cursor.
 */
export function buildMonacoPasteEdits(
  text: string,
  selections: readonly MonacoPasteRange[],
): MonacoPasteEdit[] {
  if (selections.length === 0) return [];

  const lines = text.split(/\r\n|\n/);
  const distribute = selections.length > 1 && lines.length === selections.length;

  return selections.map((selection, i) => ({
    range: selection,
    text: distribute ? lines[i]! : text,
    forceMoveMarkers: true as const,
  }));
}

export type ClipboardTextReaders = {
  readNavigator?: () => Promise<string>;
  readBridge: () => Promise<string>;
};

/**
 * Prefer navigator.clipboard, then Electron bridge.
 * Returns null when both paths fail so callers can fall back to Monaco native paste.
 */
export async function readClipboardTextWithFallbacks(
  readers: ClipboardTextReaders,
): Promise<string | null> {
  if (readers.readNavigator) {
    try {
      return await readers.readNavigator();
    } catch {
      // Fall through to Electron bridge
    }
  }

  try {
    return await readers.readBridge();
  } catch {
    return null;
  }
}

/** Minimal Monaco editor API surface used to route the built-in Paste command. */
export type MonacoPasteCommandApi = {
  getEditors: () => readonly {
    getId: () => string;
    hasTextFocus: () => boolean;
    getContainerDomNode: () => HTMLElement;
  }[];
  registerCommand: (
    id: string,
    handler: (...args: unknown[]) => void,
  ) => { dispose: () => void };
};

const bridgePasteByEditorId = new Map<string, () => void>();
let sharedPasteCommandDisposable: { dispose: () => void } | null = null;

/**
 * Route Monaco's built-in Paste command (context menu / CommandService) through
 * a bridge-backed handler for specific editors — without adding a second Paste
 * menu entry via addAction(contextMenuGroupId).
 *
 * registerCommand unshifts over the MultiCommand handler; disposing the last
 * registration restores Monaco's default paste implementation.
 */
export function registerBridgePasteForEditor(
  monacoEditor: MonacoPasteCommandApi,
  editorId: string,
  runPaste: () => void,
): { dispose: () => void } {
  bridgePasteByEditorId.set(editorId, runPaste);

  if (!sharedPasteCommandDisposable) {
    sharedPasteCommandDisposable = monacoEditor.registerCommand(
      MONACO_CLIPBOARD_PASTE_COMMAND_ID,
      () => {
        const focused = monacoEditor.getEditors().find((editor) => editor.hasTextFocus());
        if (!focused) return;

        const run = bridgePasteByEditorId.get(focused.getId());
        if (run) {
          run();
          return;
        }

        // Another editor has focus while our override is installed: use the
        // browser paste path Monaco relies on when clipboard services fail.
        focused.getContainerDomNode().ownerDocument.execCommand('paste');
      },
    );
  }

  return {
    dispose: () => {
      bridgePasteByEditorId.delete(editorId);
      if (bridgePasteByEditorId.size === 0 && sharedPasteCommandDisposable) {
        sharedPasteCommandDisposable.dispose();
        sharedPasteCommandDisposable = null;
      }
    },
  };
}

/** Test-only: reset module singletons between cases. */
export function resetBridgePasteRegistryForTests(): void {
  bridgePasteByEditorId.clear();
  sharedPasteCommandDisposable?.dispose();
  sharedPasteCommandDisposable = null;
}
